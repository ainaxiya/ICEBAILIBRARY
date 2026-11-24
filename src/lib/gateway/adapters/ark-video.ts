// ─── 火山方舟（Ark）视频生成 adapter ───
// 与 OpenAI 兼容视频链路（adapters/media.ts callVideoGenerations）并列的第二种上游形态：
//   POST {apiBase}/contents/generations/tasks       创建任务（content[] 有序数组 + 顶层参数）
//   GET  {apiBase}/contents/generations/tasks/{id}  查询状态（queued | running | succeeded | failed | expired | cancelled）
// 完成态直接给 content.video_url（24 小时有效），由调用方（video-task.ts）立刻下载转存，
// 不把外部临时地址透传给用户。提交/轮询/总超时/客户端断连语义与 callVideoGenerations 严格一致。

import { isClientAbort } from "./openai";
import {
  POLL_INTERVAL_MS,
  POLL_MAX_CONSECUTIVE_FAILURES,
  POLL_TIMEOUT_MS,
  SUBMIT_TIMEOUT_MS,
  TASK_TOTAL_TIMEOUT_MS,
  type MediaCallResult,
} from "./media";

export interface ArkVideoCallResult extends MediaCallResult {
  // 上游视频任务 usage（查询响应 usage.completion_tokens / total_tokens，供对账）
  usage?: { completionTokens: number; totalTokens: number };
  // 上游实际出片分辨率 / 时长（查询响应顶层字段，供快照）
  resolution?: string;
  duration?: number;
}

type ArkRole = "first_frame" | "last_frame" | "reference_image" | "reference_video" | "reference_audio";

interface ArkContentPart {
  type: "text" | "image_url" | "video_url" | "audio_url";
  text?: string;
  image_url?: { url: string };
  video_url?: { url: string };
  audio_url?: { url: string };
  role?: ArkRole;
}

function baseOf(apiBase: string): string {
  return apiBase.replace(/\/+$/, "");
}

function authHeaders(apiKey: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

function strOf(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function strArrayOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((it): it is string => typeof it === "string" && !!it.trim());
}

// ─── 内部请求体 → Ark 请求体（纯函数，单测可覆盖） ───
// 内部口径沿用 OpenAI 兼容字段（model/prompt/image_url/duration…），Ark 只认：
//   content[]（text 与各类参考素材按顺序混排）+ 顶层生成参数。
// 其余未知字段（n / seconds / size 等 OpenAI 口径）一律丢弃，否则 Ark 会 400。
export function arkUpstreamBody(body: Record<string, unknown>): Record<string, unknown> {
  const content: ArkContentPart[] = [];

  const prompt = strOf(body.prompt);
  if (prompt) content.push({ type: "text", text: prompt });

  // 首帧：image_url（OpenAI 兼容习惯字段）优先，兼容显式 first_frame
  const firstFrame = strOf(body.image_url) ?? strOf(body.first_frame);
  if (firstFrame) {
    content.push({ type: "image_url", image_url: { url: firstFrame }, role: "first_frame" });
  }
  const lastFrame = strOf(body.last_frame);
  if (lastFrame) {
    content.push({ type: "image_url", image_url: { url: lastFrame }, role: "last_frame" });
  }
  for (const url of strArrayOf(body.reference_images)) {
    content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
  }
  // video_url / audio_url 的 role 在 Ark 侧必填
  for (const url of strArrayOf(body.reference_videos)) {
    content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
  }
  for (const url of strArrayOf(body.reference_audios)) {
    content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
  }

  const out: Record<string, unknown> = { model: body.model, content };
  const duration = body.duration;
  if (typeof duration === "number" && Number.isFinite(duration)) {
    out.duration = Math.max(1, Math.round(duration));
  }
  for (const k of ["ratio", "resolution", "watermark", "generate_audio", "seed"] as const) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

function extractTaskId(json: unknown): string | null {
  const j = json as { id?: unknown; task_id?: unknown; task?: { id?: unknown } };
  const id = j?.task_id ?? j?.id ?? j?.task?.id;
  return typeof id === "string" && id ? id : null;
}

// 查询响应解析（只取 Ark 顶层字段）
function parsePoll(json: unknown) {
  const j = json as {
    status?: unknown;
    content?: { video_url?: unknown };
    usage?: { completion_tokens?: unknown; total_tokens?: unknown };
    error?: { message?: unknown };
    duration?: unknown;
    resolution?: unknown;
  } | null;
  const completion = Number(j?.usage?.completion_tokens);
  const total = Number(j?.usage?.total_tokens);
  const hasUsage = Number.isFinite(completion) || Number.isFinite(total);
  const duration = Number(j?.duration);
  return {
    status: String(j?.status ?? "").toLowerCase(),
    videoUrl: typeof j?.content?.video_url === "string" ? j.content.video_url : "",
    errorMessage: typeof j?.error?.message === "string" ? j.error.message : "",
    usage: hasUsage
      ? {
          completionTokens: Number.isFinite(completion) ? completion : 0,
          totalTokens: Number.isFinite(total) ? total : Number.isFinite(completion) ? completion : 0,
        }
      : undefined,
    resolution: typeof j?.resolution === "string" && j.resolution ? j.resolution : undefined,
    duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
  };
}

// 提交 → 轮询 → 取 content.video_url（与 callVideoGenerations 同签名、同返回语义）
export async function callArkVideoTask(opts: {
  apiBase: string;
  apiKey: string;
  body: Record<string, unknown>;
  // 提交任务端点（默认 contents/generations/tasks）
  path?: string;
  // 任务查询端点模板，{id} 占位（默认 contents/generations/tasks/{id}）
  pollPath?: string;
  // Ark 无幂等键；保留该字段仅为与 callVideoGenerations 签名对齐（不发送）
  idempotencyKey?: string;
  // 轮询间隔（默认 5s；网关异步任务内部执行时传短间隔加速状态流转）
  pollIntervalMs?: number;
  // 客户端取消传播：同步 HTTP 路径传请求 signal，客户端断连后停止轮询（上游已建任务不会因此撤销）
  signal?: AbortSignal;
}): Promise<ArkVideoCallResult> {
  const path = opts.path || "contents/generations/tasks";
  const pollPath = opts.pollPath || "contents/generations/tasks/{id}";
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const submitTimeoutSignal = AbortSignal.timeout(SUBMIT_TIMEOUT_MS);
  const submitSignal = opts.signal ? AbortSignal.any([submitTimeoutSignal, opts.signal]) : submitTimeoutSignal;

  // 1. 提交任务
  let submit: Response;
  try {
    submit = await fetch(`${baseOf(opts.apiBase)}/${path}`, {
      method: "POST",
      headers: authHeaders(opts.apiKey),
      body: JSON.stringify(arkUpstreamBody(opts.body)),
      signal: submitSignal,
    });
  } catch (e) {
    const aborted = isClientAbort(e, opts.signal, submitTimeoutSignal, "adapters/ark-video.callArkVideoTask");
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
    const p = parsePoll(pollJson);
    // queued / running：继续等；未知状态也按未完成处理（与 media.ts taskStatus 一致）
    if (p.status === "succeeded") {
      if (!p.videoUrl) {
        return { ok: false, status: 200, urls: [], errorMessage: "上游未返回产物地址" };
      }
      return {
        ok: true,
        status: 200,
        urls: [p.videoUrl],
        usage: p.usage,
        resolution: p.resolution,
        duration: p.duration,
      };
    }
    if (p.status === "failed" || p.status === "expired" || p.status === "cancelled") {
      return {
        ok: false,
        status: 0,
        urls: [],
        errorMessage: `生成任务失败${p.errorMessage ? `：${p.errorMessage}` : ""}`,
      };
    }
  }
}
