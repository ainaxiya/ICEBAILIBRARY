// ─── P5 站外双通道：图/视频生成 vendor adapter ───
// 两种上游形态的抽象：
//   1. sync（OpenAI images/generations 风格）：POST 一次直接拿产物 URL/b64
//   2. async_task（任务式）：提交任务 → 轮询任务状态 → 取结果 URL
// 模型 endpointType=image 走 sync，endpointType=video 走 async_task（上游若为
// 同步形态可直接复用 sync 分支）。产物 URL 由调用方转存（src/lib/assets.ts）。

import { isClientAbort } from "./openai";

export interface MediaCallResult {
  ok: boolean;
  status: number;
  // 产物 URL（http(s) 或 data:，供转存下载）
  urls: string[];
  // 产物二进制（OpenAI Videos 风格：完成态 JSON 不含地址，需单独 GET /videos/{id}/content）
  // 由调用方直接交给转存层上传，避免 base64 字符串在内存与 resultUrls 里膨胀
  content?: { bytes: Buffer; contentType: string };
  errorMessage?: string;
  // 客户端主动中止（不是上游失败）；熔断统计会忽略这类结果
  aborted?: boolean;
}

// 同步生图/任务提交的上游等待上限：60s → 10 分钟
// 2K/4K 同步出图实测会超过 60s（部分渠道 2–5 分钟），60s 会把慢图直接掐断。
// 注意：本常量同时用于 callVideoGenerations 的「任务提交」请求（只等上游建任务，通常秒回）。
// 导出给 adapters/ark-video.ts 复用：两种视频上游（OpenAI 兼容 / Ark）的超时口径必须一致。
export const SUBMIT_TIMEOUT_MS = 600_000;
export const POLL_TIMEOUT_MS = 10_000;
export const POLL_INTERVAL_MS = 5_000;
// 视频任务总等待上限：上游排队 + 渲染（30s/1080p 需要数分钟），放宽到 20 分钟
export const TASK_TOTAL_TIMEOUT_MS = 20 * 60_000;
// 轮询查询的连续失败容忍：单次 5xx / 网络抖动不代表任务失败（与站内 pollAndDeliverVideo 同口径），
// 连续 N 次才收口；4xx（任务不存在 / 鉴权失效）属查询契约失败，仍立即收口。
export const POLL_MAX_CONSECUTIVE_FAILURES = 5;
// 产物（MP4）下载上限：与转存层 MAX_DOWNLOAD_BYTES 对齐
const CONTENT_MAX_BYTES = 256 * 1024 * 1024;

function baseOf(apiBase: string): string {
  return apiBase.replace(/\/+$/, "");
}

function authHeaders(apiKey: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

function extractUrls(json: unknown): string[] {
  const urls: string[] = [];
  const root = json as {
    data?: unknown;
    url?: unknown;
    output?: unknown;
    data_url?: unknown;
    b64_json?: unknown;
    images?: unknown;
  };
  const push = (v: unknown) => {
    if (typeof v === "string" && v) urls.push(v);
  };
  const fromItem = (item: unknown) => {
    const it = item as { url?: unknown; b64_json?: unknown; video_url?: unknown; image_url?: unknown };
    if (typeof it?.url === "string") push(it.url);
    else if (typeof it?.video_url === "string") push(it.video_url);
    else if (typeof it?.image_url === "string") push(it.image_url);
    else if (typeof it?.b64_json === "string" && it.b64_json) {
      // b64 产物转 data: URL（转存层直接解码，不依赖上游 URL 有效期）
      urls.push(`data:application/octet-stream;base64,${it.b64_json}`);
    }
  };
  if (Array.isArray(root.data)) root.data.forEach(fromItem);
  else if (root.data && typeof root.data === "object") fromItem(root.data);
  if (Array.isArray(root.images)) root.images.forEach(fromItem);
  if (Array.isArray(root.output)) root.output.forEach(push);
  if (typeof root.url === "string") push(root.url);
  if (typeof root.data_url === "string") push(root.data_url);
  return urls;
}

function extractTaskId(json: unknown): string | null {
  const j = json as { id?: unknown; task_id?: unknown; task?: { id?: unknown } };
  const id = j?.task_id ?? j?.id ?? j?.task?.id;
  return typeof id === "string" && id ? id : null;
}

function taskStatus(json: unknown): { done: boolean; failed: boolean } {
  const j = json as { status?: unknown; task_status?: unknown; state?: unknown };
  const s = String(j?.status ?? j?.task_status ?? j?.state ?? "").toLowerCase();
  if (!s) return { done: false, failed: false };
  if (["succeeded", "success", "completed", "complete", "done", "finished"].includes(s)) {
    return { done: true, failed: false };
  }
  if (["failed", "error", "cancelled", "canceled"].includes(s)) {
    return { done: true, failed: true };
  }
  return { done: false, failed: false };
}

// ── 模式 1：同步生成（OpenAI images/generations 风格） ──
export async function callImageGenerations(opts: {
  apiBase: string;
  apiKey: string;
  // OpenAI 兼容 body（model/prompt/n/size 等，原样透传）
  body: Record<string, unknown>;
  // 上游端点路径（默认 images/generations）
  path?: string;
  // 请求超时（可选；不传则用默认 10 分钟，与 SUBMIT_TIMEOUT_MS 一致）
  // 后台 worker 场景可放宽，避免慢图被默认值掐断
  timeoutMs?: number;
  // 客户端取消传播：同步 HTTP 路径传请求 signal；后台 worker 不传（任务已落库，断连不中断）
  signal?: AbortSignal;
}): Promise<MediaCallResult> {
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? SUBMIT_TIMEOUT_MS);
  const fetchSignal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
  let upstream: Response;
  try {
    upstream = await fetch(`${baseOf(opts.apiBase)}/${opts.path || "images/generations"}`, {
      method: "POST",
      headers: authHeaders(opts.apiKey),
      body: JSON.stringify(opts.body),
      signal: fetchSignal,
    });
  } catch (e) {
    const aborted = isClientAbort(e, opts.signal, timeoutSignal, "adapters/media.callImageGenerations");
    const msg = aborted ? "客户端已断开" : (e as Error).name === "TimeoutError" ? "上游响应超时" : (e as Error).message;
    return { ok: false, status: 0, urls: [], errorMessage: msg, aborted };
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    let detail = "";
    try {
      detail = (JSON.parse(text)?.error?.message as string) || "";
    } catch {
      detail = text.slice(0, 200);
    }
    return {
      ok: false,
      status: upstream.status,
      urls: [],
      errorMessage: `HTTP ${upstream.status}${detail ? `：${detail}` : ""}`,
    };
  }
  const json = await upstream.json().catch(() => null);
  if (!json) return { ok: false, status: upstream.status, urls: [], errorMessage: "上游响应无法解析" };
  const urls = extractUrls(json);
  if (urls.length === 0) {
    return { ok: false, status: upstream.status, urls: [], errorMessage: "上游未返回产物地址" };
  }
  return { ok: true, status: upstream.status, urls };
}

// ── 模式 2：异步任务（提交 → 轮询 → 取结果） ──
// 上游口径（TeamoRouter / OpenAI Videos 风格，见 https://teamorouter.com/docs/video-generation-api）：
//   POST /v1/videos               创建任务（202 + id/status/progress）
//   GET  /v1/videos/{id}          查询状态（queued | in_progress | completed | failed）
//   GET  /v1/videos/{id}/content  Bearer 下载 MP4（未完成 409 / 过期 404，媒体保留 7 天）
// 完成态 JSON 里没有产物地址，必须走 /content 下载，故本分支返回 content 二进制。
export async function callVideoGenerations(opts: {
  apiBase: string;
  apiKey: string;
  body: Record<string, unknown>;
  // 提交任务端点（默认 videos）
  path?: string;
  // 任务查询端点模板，{id} 占位（默认 videos/{id}）
  pollPath?: string;
  // 产物下载端点模板，{id} 占位（默认 videos/{id}/content；上游同步返回 URL 时不使用）
  contentPath?: string;
  // 上游幂等键：建议传我们的 requestId，结果不明确时重试不会重复建任务
  idempotencyKey?: string;
  // P6：轮询间隔（默认 5s；网关异步任务内部执行时传短间隔加速状态流转）
  pollIntervalMs?: number;
  // 客户端取消传播：同步 HTTP 路径传请求 signal，客户端断连后停止轮询（上游已建任务不会因此撤销）
  signal?: AbortSignal;
}): Promise<MediaCallResult> {
  const path = opts.path || "videos";
  const pollPath = opts.pollPath || "videos/{id}";
  const contentPath = opts.contentPath || "videos/{id}/content";
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const submitTimeoutSignal = AbortSignal.timeout(SUBMIT_TIMEOUT_MS);
  const submitSignal = opts.signal ? AbortSignal.any([submitTimeoutSignal, opts.signal]) : submitTimeoutSignal;

  // 1. 提交任务
  let submit: Response;
  try {
    submit = await fetch(`${baseOf(opts.apiBase)}/${path}`, {
      method: "POST",
      headers: {
        ...authHeaders(opts.apiKey),
        ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
      },
      body: JSON.stringify(videoUpstreamBody(opts.body)),
      signal: submitSignal,
    });
  } catch (e) {
    const aborted = isClientAbort(e, opts.signal, submitTimeoutSignal, "adapters/media.callVideoGenerations");
    const msg = aborted ? "客户端已断开" : (e as Error).name === "TimeoutError" ? "上游响应超时" : (e as Error).message;
    return { ok: false, status: 0, urls: [], errorMessage: msg, aborted };
  }
  const submitJson = await submit.json().catch(() => null);
  if (!submit.ok) {
    const detail = (submitJson as { error?: { message?: string } })?.error?.message || "";
    return {
      ok: false,
      status: submit.status,
      urls: [],
      errorMessage: `HTTP ${submit.status}${detail ? `：${detail}` : ""}`,
    };
  }
  // 提交即返回产物（少数上游同步返回）
  const immediate = extractUrls(submitJson);
  if (immediate.length > 0) return { ok: true, status: submit.status, urls: immediate };

  const taskId = extractTaskId(submitJson);
  if (!taskId) {
    return { ok: false, status: submit.status, urls: [], errorMessage: "上游未返回任务 ID" };
  }

  // 2. 轮询任务
  const deadline = Date.now() + TASK_TOTAL_TIMEOUT_MS;
  let consecutivePollFailures = 0;
  for (;;) {
    if (Date.now() > deadline) {
      return { ok: false, status: 0, urls: [], errorMessage: "生成任务等待超时" };
    }
    // 客户端已断连：停止轮询（上游任务在提交时已计费，撤销不了；继续轮询只是白等）
    if (opts.signal?.aborted) {
      return { ok: false, status: 0, urls: [], errorMessage: "客户端已断开", aborted: true };
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    let pollJson: unknown = null;
    let pr: Response;
    try {
      pr = await fetch(`${baseOf(opts.apiBase)}/${pollPath.replace("{id}", encodeURIComponent(taskId))}`, {
        method: "GET",
        headers: authHeaders(opts.apiKey),
        signal: AbortSignal.any([AbortSignal.timeout(POLL_TIMEOUT_MS), ...(opts.signal ? [opts.signal] : [])]),
      });
      pollJson = await pr.json().catch(() => null);
    } catch (e) {
      // 客户端断连则立即收口为取消
      if (opts.signal?.aborted) {
        return { ok: false, status: 0, urls: [], errorMessage: "客户端已断开", aborted: true };
      }
      // 单次网络抖动：计数后继续等，连续失败达上限才判失败
      consecutivePollFailures += 1;
      if (consecutivePollFailures >= POLL_MAX_CONSECUTIVE_FAILURES) {
        const why = (e as Error)?.name === "TimeoutError" ? "任务查询超时" : (e as Error).message;
        return {
          ok: false,
          status: 0,
          urls: [],
          errorMessage: `任务查询连续失败 ${consecutivePollFailures} 次（${why}）`,
        };
      }
      continue;
    }
    if (!pr.ok) {
      // 5xx / 408 / 429 属临时查询失败：按连续次数容忍，避免一次抖动把在跑的任务判失败退款
      const transient = pr.status >= 500 || pr.status === 408 || pr.status === 429;
      if (transient) {
        consecutivePollFailures += 1;
        if (consecutivePollFailures < POLL_MAX_CONSECUTIVE_FAILURES) continue;
        return {
          ok: false,
          status: pr.status,
          urls: [],
          errorMessage: `任务查询连续失败 ${consecutivePollFailures} 次（HTTP ${pr.status}）`,
        };
      }
      // 4xx（任务不存在 / 鉴权失效等）：查询契约已失败，重试无意义
      return {
        ok: false,
        status: pr.status,
        urls: [],
        errorMessage: `任务查询失败 HTTP ${pr.status}`,
      };
    }
    consecutivePollFailures = 0;
    const st = taskStatus(pollJson);
    if (st.failed) {
      const detail = (pollJson as { error?: { message?: string }; message?: string })?.error?.message
        || (pollJson as { message?: string })?.message || "";
      return { ok: false, status: 0, urls: [], errorMessage: `生成任务失败${detail ? `：${detail}` : ""}` };
    }
    if (st.done) {
      // 兜底：部分上游完成态直接给地址
      const urls = extractUrls(pollJson);
      if (urls.length > 0) return { ok: true, status: 200, urls };
      // 标准 OpenAI Videos：完成态无地址，单独下载二进制
      const got = await downloadVideoContent({
        apiBase: opts.apiBase,
        apiKey: opts.apiKey,
        path: contentPath.replace("{id}", encodeURIComponent(taskId)),
        signal: opts.signal,
      });
      if (!got.ok) {
        return { ok: false, status: got.status, urls: [], errorMessage: got.errorMessage };
      }
      return { ok: true, status: 200, urls: [], content: got.content };
    }
  }
}

// 上游请求体归一化：OpenAI Videos 用 seconds（整数字符串），不认 duration 数字与 n
function videoUpstreamBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  delete out.n; // 一次一条；条数只用于预扣估算，结算按实际产物数
  const duration = out.duration;
  delete out.duration; // 与 seconds 冲突：上游要求二者不可同时提交
  if (out.seconds == null && typeof duration === "number" && Number.isFinite(duration)) {
    out.seconds = String(Math.max(1, Math.round(duration)));
  }
  return out;
}

// 下载已完成任务的 MP4（需要 Bearer，不能交给无鉴权的转存层直连）
async function downloadVideoContent(opts: {
  apiBase: string;
  apiKey: string;
  path: string;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; content: { bytes: Buffer; contentType: string } }
  | { ok: false; status: number; errorMessage: string }
> {
  const timeoutSignal = AbortSignal.timeout(SUBMIT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
  let res: Response;
  try {
    res = await fetch(`${baseOf(opts.apiBase)}/${opts.path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal,
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      errorMessage:
        (e as Error)?.name === "TimeoutError"
          ? "产物下载超时"
          : `产物下载失败：${(e as Error).message}`,
    };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    res.body?.cancel().catch(() => {});
    return {
      ok: false,
      status: res.status,
      errorMessage: `产物下载失败 HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ""}`,
    };
  }
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > CONTENT_MAX_BYTES) {
    res.body?.cancel().catch(() => {});
    return { ok: false, status: res.status, errorMessage: "产物体积超过上限" };
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) return { ok: false, status: res.status, errorMessage: "上游产物为空" };
  if (bytes.length > CONTENT_MAX_BYTES) {
    return { ok: false, status: res.status, errorMessage: "产物体积超过上限" };
  }
  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim() || "video/mp4";
  return { ok: true, content: { bytes, contentType } };
}

// 统一分发：endpointType=image → 同步；video → 异步任务
export async function callMediaGenerations(opts: {
  endpointType: "image" | "video";
  apiBase: string;
  apiKey: string;
  body: Record<string, unknown>;
  // 仅图片分支透传（视频走自身轮询总超时，不受此参数影响）
  timeoutMs?: number;
  // 客户端取消传播（同步 HTTP 路径传；后台 worker 不传）
  signal?: AbortSignal;
}): Promise<MediaCallResult> {
  if (opts.endpointType === "image") {
    return callImageGenerations(opts);
  }
  return callVideoGenerations(opts);
}
