// ─── P5 站外双通道：图/视频生成 vendor adapter ───
// 两种上游形态的抽象：
//   1. sync（OpenAI images/generations 风格）：POST 一次直接拿产物 URL/b64
//   2. async_task（任务式）：提交任务 → 轮询任务状态 → 取结果 URL
// 模型 endpointType=image 走 sync，endpointType=video 走 async_task（上游若为
// 同步形态可直接复用 sync 分支）。产物 URL 由调用方转存（src/lib/assets.ts）。

export interface MediaCallResult {
  ok: boolean;
  status: number;
  // 产物 URL（http(s) 或 data:，供转存下载）
  urls: string[];
  errorMessage?: string;
}

const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 5_000;
const TASK_TOTAL_TIMEOUT_MS = 600_000;

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
}): Promise<MediaCallResult> {
  let upstream: Response;
  try {
    upstream = await fetch(`${baseOf(opts.apiBase)}/${opts.path || "images/generations"}`, {
      method: "POST",
      headers: authHeaders(opts.apiKey),
      body: JSON.stringify(opts.body),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "上游响应超时" : (e as Error).message;
    return { ok: false, status: 0, urls: [], errorMessage: msg };
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
export async function callVideoGenerations(opts: {
  apiBase: string;
  apiKey: string;
  body: Record<string, unknown>;
  // 提交任务端点（默认 videos/generations）
  path?: string;
  // 任务查询端点模板，{id} 占位（默认 videos/generations/{id}）
  pollPath?: string;
}): Promise<MediaCallResult> {
  const path = opts.path || "videos/generations";
  const pollPath = opts.pollPath || `${path}/{id}`;

  // 1. 提交任务
  let submit: Response;
  try {
    submit = await fetch(`${baseOf(opts.apiBase)}/${path}`, {
      method: "POST",
      headers: authHeaders(opts.apiKey),
      body: JSON.stringify(opts.body),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "上游响应超时" : (e as Error).message;
    return { ok: false, status: 0, urls: [], errorMessage: msg };
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
  // 提交即返回产物（部分上游同步返回）
  const immediate = extractUrls(submitJson);
  if (immediate.length > 0) return { ok: true, status: submit.status, urls: immediate };

  const taskId = extractTaskId(submitJson);
  if (!taskId) {
    return { ok: false, status: submit.status, urls: [], errorMessage: "上游未返回任务 ID" };
  }

  // 2. 轮询任务
  const deadline = Date.now() + TASK_TOTAL_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) {
      return { ok: false, status: 0, urls: [], errorMessage: "生成任务等待超时" };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let pollJson: unknown = null;
    try {
      const pr = await fetch(`${baseOf(opts.apiBase)}/${pollPath.replace("{id}", encodeURIComponent(taskId))}`, {
        method: "GET",
        headers: authHeaders(opts.apiKey),
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
      pollJson = await pr.json().catch(() => null);
      if (!pr.ok) {
        return {
          ok: false,
          status: pr.status,
          urls: [],
          errorMessage: `任务查询失败 HTTP ${pr.status}`,
        };
      }
    } catch {
      continue; // 单次轮询网络抖动：继续等
    }
    const st = taskStatus(pollJson);
    if (st.failed) {
      const detail = (pollJson as { error?: { message?: string }; message?: string })?.error?.message
        || (pollJson as { message?: string })?.message || "";
      return { ok: false, status: 0, urls: [], errorMessage: `生成任务失败${detail ? `：${detail}` : ""}` };
    }
    if (st.done) {
      const urls = extractUrls(pollJson);
      if (urls.length === 0) {
        return { ok: false, status: 0, urls: [], errorMessage: "生成任务完成但未返回产物地址" };
      }
      return { ok: true, status: 200, urls };
    }
  }
}

// 统一分发：endpointType=image → 同步；video → 异步任务
export async function callMediaGenerations(opts: {
  endpointType: "image" | "video";
  apiBase: string;
  apiKey: string;
  body: Record<string, unknown>;
}): Promise<MediaCallResult> {
  if (opts.endpointType === "image") {
    return callImageGenerations(opts);
  }
  return callVideoGenerations(opts);
}
