// ─── P4 #21 语音端点 adapter（OpenAI 兼容上游） ───
// transcriptions / translations：multipart/form-data 转发（原生 FormData + Blob），
//   响应按文本透传；verbose_json 的 duration 秒数旁路提取供按分钟结算。
// speech：JSON 请求 → 二进制音频整包透传（TTS 音频量级 MB 级，整包缓冲可接受）。
// anthropic / gemini 上游无语音能力（路由层提前拦截）。

import { NextRequest, NextResponse } from "next/server";
import { authenticateV1, type V1Auth } from "./auth";
import { isModelAllowedForAuth } from "./model-access";
import { billing } from "./billing";
import { apiError, gatewayError } from "./errors";
import { resolveRequestId } from "./idempotency";
import { costMilli, displayMemberCredits, pricingSnapshot } from "./pricing";
import { markKeyUsed, recordKeyOutcome, releaseKeyProbe, resolveRoute, tryAcquireKeyCall, type KeyCandidate } from "./router";
import { recordUsage, type UsageInput } from "./usage";
import { acquireSlot, checkKeyRpm, checkQuota, getQuotaConfig } from "@/lib/quota";

const UPSTREAM_TIMEOUT_MS = 300000;
// 上传音频大小上限（对齐 OpenAI 25MB）
export const AUDIO_UPLOAD_LIMIT = 25 * 1024 * 1024;

function baseOf(apiBase: string): string {
  return apiBase.replace(/\/+$/, "");
}

// ─── STT：transcriptions / translations ───

export interface AudioSttResult {
  ok: boolean;
  status: number;
  // 响应 Content-Type（透传给客户端）
  contentType?: string;
  // 响应体文本（json / text / srt / vtt 原样透传）
  bodyText?: string;
  // verbose_json 中的 duration（秒）；无则 null
  durationSec?: number | null;
  errorMessage?: string;
}

export async function callAudioStt(opts: {
  // "transcriptions" | "translations"
  path: string;
  apiBase: string;
  apiKey: string;
  // 上传文件（req.formData() 解析出的 Blob/File，可跨 fetch 重试复用）
  file: Blob;
  fileName: string;
  // 其余表单字段（model/language/prompt/response_format/temperature）
  fields: Record<string, string>;
  signal?: AbortSignal;
}): Promise<AudioSttResult> {
  const fd = new FormData();
  fd.append("file", opts.file, opts.fileName);
  for (const [k, v] of Object.entries(opts.fields)) {
    if (v !== "" && v != null) fd.append(k, v);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${baseOf(opts.apiBase)}/audio/${opts.path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: fd,
      signal: opts.signal ? AbortSignal.any([AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), opts.signal]) : AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "上游响应超时" : (e as Error).message;
    return { ok: false, status: 0, errorMessage: msg };
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    let detail = "";
    try {
      detail = String((JSON.parse(text)?.error as { message?: unknown } | undefined)?.message ?? "");
    } catch {
      detail = text.slice(0, 200);
    }
    return { ok: false, status: upstream.status, errorMessage: `HTTP ${upstream.status}${detail ? `：${detail}` : ""}` };
  }

  const bodyText = await upstream.text().catch(() => "");
  let durationSec: number | null = null;
  try {
    const j = JSON.parse(bodyText) as { duration?: unknown };
    if (typeof j.duration === "number" && j.duration > 0) durationSec = j.duration;
  } catch {
    // text/srt/vtt 格式无 JSON，无时长信息
  }
  return {
    ok: true,
    status: upstream.status,
    contentType: upstream.headers.get("content-type") ?? "application/json",
    bodyText,
    durationSec,
  };
}

// ─── TTS：speech ───

export interface AudioSpeechResult {
  ok: boolean;
  status: number;
  contentType?: string;
  bytes?: ArrayBuffer;
  errorMessage?: string;
}

export async function callAudioSpeech(opts: {
  apiBase: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<AudioSpeechResult> {
  let upstream: Response;
  try {
    upstream = await fetch(`${baseOf(opts.apiBase)}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(opts.body),
      signal: opts.signal ? AbortSignal.any([AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), opts.signal]) : AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "上游响应超时" : (e as Error).message;
    return { ok: false, status: 0, errorMessage: msg };
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    let detail = "";
    try {
      detail = String((JSON.parse(text)?.error as { message?: unknown } | undefined)?.message ?? "");
    } catch {
      detail = text.slice(0, 200);
    }
    return { ok: false, status: upstream.status, errorMessage: `HTTP ${upstream.status}${detail ? `：${detail}` : ""}` };
  }

  const bytes = await upstream.arrayBuffer();
  return {
    ok: true,
    status: upstream.status,
    contentType: upstream.headers.get("content-type") ?? "audio/mpeg",
    bytes,
  };
}

// ─── 计量（定价 unit 约定） ───
// audio_minute：按分钟计费（meterBase=1，memberInputPrice=积分/分钟）
// char：按字符计费（meterBase=1000，memberInputPrice=积分/千字符）
// 其他 unit 兜底按 1 次计量

export function unitsForAudioMinute(durationSec: number | null | undefined, fileSize: number): number {
  if (durationSec && durationSec > 0) return Math.max(1, Math.ceil(durationSec / 60));
  // 无时长信息：按文件大小粗估（1MB ≈ 1 分钟），最低 1 分钟
  return Math.max(1, Math.ceil(fileSize / 1_000_000));
}

export function unitsForChars(text: string): number {
  return Math.max(1, text.length);
}

// ─── STT 路由共享处理器（transcriptions / translations 同构） ───
// 鉴权 → multipart 解析（file 25MB 上限）→ 配额 → 预检（endpointType=audio +
// endpoint=audio_{path} + 仅 openai 协议上游）→ 预扣 → 换 Key 重试 → 按
// duration 分钟结算（多退少补）→ 响应文本透传。

// 鉴权失败统一响应（复用三路由）
export function authError(auth: { ok: false; status: number; message: string; code: string }): NextResponse {
  return apiError(auth.status, auth.message, "authentication_error", auth.code);
}

export type SttPath = "transcriptions" | "translations";

export async function handleAudioStt(req: NextRequest, sttPath: SttPath): Promise<Response> {
  // ── 1. 鉴权 ──
  const auth: V1Auth = await authenticateV1(req);
  if (!auth.ok) return authError(auth);
  const user = auth.user;
  const channel = auth.channel;
  const apiKeyId = auth.apiKeyId;

  // ── 2. multipart 解析 ──
  const form = await req.formData().catch(() => null);
  if (!form) {
    return gatewayError("invalid_body", { message: "Expected multipart/form-data with a 'file' field" });
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return gatewayError("invalid_body", { message: "Field 'file' is required (audio file)" });
  }
  if (file.size > AUDIO_UPLOAD_LIMIT) {
    return gatewayError("file_too_large", { message: "Audio file exceeds the 25MB upload limit" });
  }
  const modelRaw = form.get("model");
  const model = typeof modelRaw === "string" && modelRaw ? modelRaw : "";
  if (!model) {
    return gatewayError("invalid_body", { message: "Field 'model' is required" });
  }
  // b1：Key 模型白名单（空白名单 = 不限制）
  if (!isModelAllowedForAuth(auth, model)) {
    return gatewayError("model_not_allowed", {
      message: `Model "${model}" is not allowed for this API key`,
    });
  }
  const fileName = file instanceof File && file.name ? file.name : "audio.bin";
  const fields: Record<string, string> = {};
  for (const k of ["language", "prompt", "response_format", "temperature"]) {
    const v = form.get(k);
    if (typeof v === "string" && v !== "") fields[k] = v;
  }

  // ── 3. 配额 ──
  if (channel === "apikey") {
    const keyQuota = await checkKeyRpm(apiKeyId!);
    if (!keyQuota.ok) {
      return gatewayError("quota_exceeded", { message: keyQuota.error || undefined });
    }
  } else {
    const quota = await checkQuota(user.id);
    if (!quota.ok) {
      return gatewayError("quota_exceeded", { message: quota.error || undefined });
    }
  }

  // ── 4. 预检：模型 / 端点 / 定价 / 上游协议 ──
  const route = await resolveRoute(model);
  if (!route) {
    return gatewayError("model_not_found");
  }
  if (route.model.endpointType !== "audio") {
    return gatewayError("endpoint_disabled", { message: `This model does not support the audio_${sttPath} endpoint` });
  }
  const endpoint = route.endpoints.find((e) => e.path === `audio_${sttPath}` && e.enabled);
  if (!endpoint) {
    return gatewayError("endpoint_disabled", { message: `This model does not support the audio_${sttPath} endpoint` });
  }
  const pricing = route.pricing;
  if (!pricing) {
    return gatewayError("pricing_not_configured");
  }
  // STT 上游仅 OpenAI 兼容协议（anthropic/gemini 无语音端点）
  if (route.vendor.protocol !== "openai") {
    return gatewayError("endpoint_unsupported", { message: "Upstream protocol does not support audio endpoints" });
  }

  // L1：绑定端点 + 模型 + 请求体指纹。25MB 音频不读内容进哈希，
  // 用「文件名 + 大小 + 类型 + 表单字段」做稳定指纹（同一文件重试得到同一 requestId）
  const requestId = resolveRequestId(user.id, req, {
    endpoint: `audio.${sttPath}`,
    model,
    body: { name: fileName, size: file.size, type: file.type, fields },
  });
  const estMinutes = Math.max(1, Math.ceil(file.size / 1_000_000)); // 1MB ≈ 1 分钟粗估
  const estCredits = displayMemberCredits(pricing, estMinutes, 0);

  const baseUsage: Omit<UsageInput, "status" | "costMilli" | "paidCredits" | "vendorKeyId"> = {
    requestId,
    userId: user.id,
    channel,
    apiKeyId,
    modelId: route.model.id,
    endpointType: "audio",
    modelSnapshot: model,
    promptTokens: 0,
    outputTokens: 0,
  };

  // ── 5. 余额预检（g19：不预扣，成功后按实际结算） ──
  const pre = await billing.preCheck(user.id, estCredits, "audio", 0, apiKeyId);
  if (!pre.ok) {
    return pre.code === "key_quota_exceeded"
      ? gatewayError("key_quota_exceeded", { message: pre.error || undefined })
      : gatewayError("insufficient_credits", { message: pre.error || undefined });
  }

  // ── 6. 并发槽 ──
  const quotaCfg = await getQuotaConfig();
  const slot = await acquireSlot(user.id, quotaCfg.concurrency);
  if (!slot.ok) {
    await billing.refund(user.id, requestId);
    return gatewayError("concurrency_exceeded");
  }

  // ── 7. 路由选 Key + adapter（失败换下一个，最多 3 个） ──
  const attempts: KeyCandidate[] = route.candidates.slice(0, 3);
  if (attempts.length === 0) {
    slot.release();
    await billing.refund(user.id, requestId);
    await recordUsage({ ...baseUsage, vendorKeyId: null, status: "failed", costMilli: 0, paidCredits: 0 });
    return gatewayError("no_upstream_key");
  }

  let result: Awaited<ReturnType<typeof callAudioStt>> | null = null;
  let used: KeyCandidate | null = null;
  let lastError = "";
  for (const cand of attempts) {
    // U2：真正调用前才占用半开探测名额；名额已被占用则跳过该 Key
    if (!tryAcquireKeyCall(cand.vendorKeyId)) continue;
    markKeyUsed(cand.vendorKeyId);
    let r: Awaited<ReturnType<typeof callAudioStt>>;
    try {
      r = await callAudioStt({ path: sttPath, apiBase: cand.apiBase, apiKey: cand.apiKey, file, fileName, fields });
    } catch (e) {
      releaseKeyProbe(cand.vendorKeyId); // 异常退出也要归还探测名额
      throw e;
    }
    recordKeyOutcome(cand.vendorKeyId, r.ok, r.ok ? 200 : r.status || 502);
    if (r.ok) {
      result = r;
      used = cand;
      break;
    }
    lastError = r.errorMessage || `HTTP ${r.status}`;
  }

  if (!result || !used) {
    slot.release();
    await billing.refund(user.id, requestId);
    await recordUsage({ ...baseUsage, vendorKeyId: null, status: "failed", costMilli: 0, paidCredits: 0 });
    return gatewayError("upstream_error", { message: `Upstream audio service error: ${lastError}` });
  }

  // ── 8. 结算：按上游 duration 分钟数（缺省按文件大小粗估）多退少补 ──
  const units = unitsForAudioMinute(result.durationSec, file.size);
  const paid = displayMemberCredits(pricing, units, 0);
  await billing.settle(user.id, requestId, paid, apiKeyId);
  slot.release();
  await recordUsage({
    ...baseUsage,
    vendorKeyId: used.vendorKeyId,
    unitCount: units,
    // 成本按定价行输入侧单价换算（毫积分），与视频/图片同口径；此前恒为 0 导致毛利报表缺失
    costMilli: costMilli(units, pricing, "input"),
    paidCredits: paid,
    status: "success",
    ...pricingSnapshot(pricing),
  });

  return new Response(result.bodyText ?? "", {
    status: 200,
    headers: { "Content-Type": result.contentType ?? "application/json", "Cache-Control": "no-store" },
  });
}
