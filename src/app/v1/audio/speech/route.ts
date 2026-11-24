import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateV1, type V1Auth } from "@/lib/gateway/auth";
import { isModelAllowedForAuth } from "@/lib/gateway/model-access";
import { billing } from "@/lib/gateway/billing";
import { apiError, gatewayError } from "@/lib/gateway/errors";
import { resolveRequestId } from "@/lib/gateway/idempotency";
import { callAudioSpeech, unitsForChars } from "@/lib/gateway/audio";
import {
  buildCreateBody,
  buildSubmitBody,
  callBytedanceTtsCreate,
  callBytedanceTtsSubmit,
  illegalControlRatio,
  mapAudioFormat,
  resolveBytedanceTtsConfig,
  validateReferences,
  waitBytedanceTtsTask,
  type BytedanceTtsConfig,
  type BytedanceTtsReference,
} from "@/lib/gateway/adapters/bytedance-tts";
import { costMilli, displayMemberCredits, pricingSnapshot } from "@/lib/gateway/pricing";
import { markKeyUsed, recordKeyOutcome, releaseKeyProbe, resolveRoute, tryAcquireKeyCall, type KeyCandidate } from "@/lib/gateway/router";
import { recordUsage, type UsageInput } from "@/lib/gateway/usage";
import { acquireSlot, checkKeyRpm, checkQuota, getQuotaConfig } from "@/lib/quota";
import { acquireChannel } from "@/lib/queue/channel-gate";
import { db } from "@/lib/db";
import { sniffMediaType } from "@/lib/assets";
import { fetchBytes } from "@/lib/playground/media-store";
import { saveUpload } from "@/lib/upload-store.server";
import { kindForExt } from "@/lib/upload-naming";

export const dynamic = "force-dynamic";

// ─── POST /v1/audio/speech —— P4 #21 文字转语音（OpenAI 兼容，二进制响应） ───
// 对外统一入口，按厂商协议 / 模型分流：
//   openai     ：JSON 转发上游 /audio/speech，按输入字符数（unit=char，meterBase=1000）计量
//   bytedance  ：字节跳动语音适配器（历史值 openspeech 兼容等价）
//     · seed-audio-*   → /api/v3/tts/create 同步生成，按 original_duration 秒（unit=audio_second）
//     · seed-tts-* / seed-icl-* → /api/v3/tts/submit + query 异步长文本，按字符（unit=char）
// 异步任务拿到下载链接后立即转存本地，库里只落本地地址，不长期引用上游 1 小时链接。

const speechSchema = z
  .object({
    model: z.string().min(1),
    // create 单次 ≤3000 字；submit 单次 ≤10 万字符（按模型在上方再校验）
    input: z.string().min(1).max(100000),
    voice: z.string().min(1),
    response_format: z.string().optional(),
    speed: z.number().min(0.25).max(4).optional(),
    // 可选：上游 references 三种形态（speaker / audio_* / image_*），按文档校验互斥与数量
    references: z.array(z.record(z.string(), z.unknown())).max(3).optional(),
    // 可选：上游采样率；不传则用官方默认
    sample_rate: z.number().int().positive().optional(),
  })
  .passthrough();

// 同步生成上限（文档：输出 ≤120s）
const MAX_CREATE_SECONDS = 120;
const MAX_CREATE_CHARS = 3000;
const MAX_ASYNC_CHARS = 100000;

function mimeOfFormat(format: string): string {
  switch (format) {
    case "wav":
      return "audio/wav";
    case "pcm":
      return "audio/L16";
    case "ogg_opus":
      return "audio/ogg";
    default:
      return "audio/mpeg";
  }
}

function extOfFormat(format: string): string {
  switch (format) {
    case "wav":
      return "wav";
    case "pcm":
      return "pcm";
    case "ogg_opus":
      return "ogg";
    default:
      return "mp3";
  }
}

// 无 original_duration 时的兜底估时（5 字/秒），并夹到 [1,120]
function estimateCreateSeconds(text: string): number {
  return Math.max(1, Math.min(MAX_CREATE_SECONDS, Math.ceil(text.length / 5)));
}

interface OutcomeOk {
  ok: true;
  bytes: Uint8Array;
  contentType: string;
  // 结算计量值：audio_second 模式=秒；char 模式=字符数
  measure: number;
  // 异步转存后的本地地址（仅 bytedance submit）
  assetUrl?: string;
}
interface OutcomeFail {
  ok: false;
  httpStatus: number;
  code: string;
  message: string;
}
type Outcome = OutcomeOk | OutcomeFail;

export async function POST(req: NextRequest) {
  // ── 1. 鉴权 ──
  const auth: V1Auth = await authenticateV1(req);
  if (!auth.ok) {
    return apiError(auth.status, auth.message, "authentication_error", auth.code);
  }
  const user = auth.user;
  const channel = auth.channel;
  const apiKeyId = auth.apiKeyId;

  // ── 2. 请求体校验 ──
  const raw = await req.json().catch(() => null);
  const parsed = speechSchema.safeParse(raw);
  if (!parsed.success) {
    return gatewayError("invalid_body", { message: "Invalid request body: " + parsed.error.issues[0]?.message });
  }
  const body = parsed.data;

  // b1：Key 模型白名单（空白名单 = 不限制）
  if (!isModelAllowedForAuth(auth, body.model)) {
    return gatewayError("model_not_allowed", {
      message: `Model "${body.model}" is not allowed for this API key`,
    });
  }
  const input = body.input;

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
  const route = await resolveRoute(body.model);
  if (!route) {
    return gatewayError("model_not_found");
  }
  if (route.model.endpointType !== "audio") {
    return gatewayError("endpoint_disabled", { message: "This model does not support the audio_speech endpoint" });
  }
  const endpoint = route.endpoints.find((e) => e.path === "audio_speech" && e.enabled);
  if (!endpoint) {
    return gatewayError("endpoint_disabled", { message: "This model does not support the audio_speech endpoint" });
  }
  const pricing = route.pricing;
  if (!pricing) {
    return gatewayError("pricing_not_configured");
  }
  const protocol = route.vendor.protocol;
  // bytedance 为当前标识；openspeech 为历史值，读取时等价兼容
  const isBytedance = protocol === "bytedance" || protocol === "openspeech";
  if (!isBytedance && protocol !== "openai") {
    return gatewayError("endpoint_unsupported", { message: "Upstream protocol does not support audio endpoints" });
  }

  // ── 5. bytedance 预校验：模式 / 格式 / 长度 / 控制字符 / references ──
  let bdCfg: BytedanceTtsConfig | null = null;
  let format = "mp3";
  let references: BytedanceTtsReference[] = [];

  if (isBytedance) {
    bdCfg = resolveBytedanceTtsConfig(route.model.name, route.model.advancedConfig);
    if (!bdCfg) {
      return gatewayError("endpoint_unsupported", {
        message: `Model "${body.model}" is not a bytedance TTS model (expected seed-audio-* or seed-tts-*/seed-icl-*)`,
      });
    }
    const fmt = mapAudioFormat(body.response_format, bdCfg.mode);
    if ("error" in fmt) {
      return gatewayError("invalid_body", { message: fmt.error });
    }
    format = fmt.format;

    if (bdCfg.mode === "create") {
      if (pricing.unit !== "audio_second" || Number(pricing.meterBase) !== 1) {
        return gatewayError("pricing_not_configured", {
          status: 400,
          message: "Model pricing must be unit=audio_second with meterBase=1 for synced audio generation",
        });
      }
      if (input.length > MAX_CREATE_CHARS) {
        return gatewayError("invalid_body", {
          message: `input exceeds ${MAX_CREATE_CHARS} characters for synced generation; use an async model (seed-tts-*) for long text`,
        });
      }
    } else {
      if (pricing.unit !== "char" || Number(pricing.meterBase) !== 1000) {
        return gatewayError("pricing_not_configured", {
          status: 400,
          message: "Model pricing must be unit=char with meterBase=1000 for async speech synthesis",
        });
      }
      if (input.length > MAX_ASYNC_CHARS) {
        return gatewayError("invalid_body", { message: `input exceeds ${MAX_ASYNC_CHARS} characters` });
      }
      // 文档：非法控制字符（不含 \t \n）占比 >10% 直接报错
      if (illegalControlRatio(input) > 0.1) {
        return gatewayError("invalid_body", { message: "input contains too many illegal control characters" });
      }
    }

    const refCheck = validateReferences(body.voice, body.references as BytedanceTtsReference[] | undefined);
    if (!refCheck.ok) {
      return gatewayError("invalid_body", { message: refCheck.error });
    }
    references = refCheck.references;
  }

  // L1：绑定端点 + 模型 + 请求体指纹，防止同一 Key 跨端点/换参数复用旧扣费
  const requestId = resolveRequestId(user.id, req, { endpoint: "audio.speech", model: body.model, body });

  // ── 6. 预估计量 + 预扣 ──
  // bytedance create 预先不知道时长，按 120 秒上限预扣，成功后按 original_duration 多退少补
  const estMeasure = isBytedance
    ? bdCfg!.mode === "create"
      ? MAX_CREATE_SECONDS
      : unitsForChars(input)
    : unitsForChars(input);
  const estCredits = displayMemberCredits(pricing, estMeasure, 0);

  const baseUsage: Omit<UsageInput, "status" | "costMilli" | "paidCredits" | "vendorKeyId"> = {
    requestId,
    userId: user.id,
    channel,
    apiKeyId,
    modelId: route.model.id,
    endpointType: "audio",
    modelSnapshot: body.model,
    promptTokens: 0,
    outputTokens: 0,
  };

  const pre = await billing.preCheck(user.id, estCredits, "audio", 0, apiKeyId);
  if (!pre.ok) {
    return pre.code === "key_quota_exceeded"
      ? gatewayError("key_quota_exceeded", { message: pre.error || undefined })
      : gatewayError("insufficient_credits", { message: pre.error || undefined });
  }
  // g19：音频不再预扣，成功后按实际时长结算（settle 内累加 Key 已用额度）

  // ── 7. 并发槽 ──
  const quotaCfg = await getQuotaConfig();
  const slot = await acquireSlot(user.id, quotaCfg.concurrency);
  if (!slot.ok) {
    await billing.refund(user.id, requestId);
    return gatewayError("concurrency_exceeded");
  }

  // ── 7.5 全站音频并发闸门（后台设置 queue_config.audio）──
  // 超过上限先排队等待，等不到才退款并 429；与文本闸门互不影响。
  const gate = await acquireChannel("audio");
  if (!gate.ok) {
    slot.release();
    await billing.refund(user.id, requestId);
    return gatewayError("concurrency_exceeded");
  }
  const releaseAll = () => {
    gate.release();
    slot.release();
  };

  // ── 8. 路由选 Key + adapter（失败换下一个，最多 3 个） ──
  const attempts: KeyCandidate[] = route.candidates.slice(0, 3);
  if (attempts.length === 0) {
    releaseAll();
    await billing.refund(user.id, requestId);
    await recordUsage({ ...baseUsage, vendorKeyId: null, status: "failed", costMilli: 0, paidCredits: 0 });
    return gatewayError("no_upstream_key");
  }

  let outcome: Outcome | null = null;
  let used: KeyCandidate | null = null;
  let lastFail: OutcomeFail = { ok: false, httpStatus: 502, code: "upstream_error", message: "Upstream audio service error" };

  for (const cand of attempts) {
    // U2：真正调用前才占用半开探测名额；名额已被占用则跳过该 Key
    if (!tryAcquireKeyCall(cand.vendorKeyId)) continue;
    markKeyUsed(cand.vendorKeyId);

    try {
      if (!isBytedance) {
        // ── OpenAI 兼容上游（行为保持不变） ──
        const r = await callAudioSpeech({ apiBase: cand.apiBase, apiKey: cand.apiKey, body: body as Record<string, unknown> });
        recordKeyOutcome(cand.vendorKeyId, r.ok, r.ok ? 200 : r.status || 502);
        if (r.ok) {
          outcome = {
            ok: true,
            bytes: new Uint8Array(r.bytes ?? new ArrayBuffer(0)),
            contentType: r.contentType ?? "audio/mpeg",
            measure: unitsForChars(input),
          };
          used = cand;
          break;
        }
        lastFail = { ok: false, httpStatus: r.status >= 400 && r.status < 500 ? 400 : 502, code: "upstream_error", message: r.errorMessage || `HTTP ${r.status}` };
        // 参数/鉴权类错误换 Key 无意义，直接结束
        if (r.status >= 400 && r.status < 500) break;
        continue;
      }

      if (bdCfg!.mode === "create") {
        // ── 同步音频生成 ──
        const r = await callBytedanceTtsCreate({
          apiBase: cand.apiBase,
          apiKey: cand.apiKey,
          requestId: randomUUID(),
          body: buildCreateBody(bdCfg!, {
            text: input,
            format,
            sampleRate: body.sample_rate,
            speed: body.speed,
            references,
          }),
        });
        recordKeyOutcome(cand.vendorKeyId, r.ok, r.ok ? 200 : r.status || 502);
        if (r.ok) {
          const secs = r.originalDurationSec ?? r.durationSec ?? estimateCreateSeconds(input);
          outcome = {
            ok: true,
            bytes: new Uint8Array(Buffer.from(r.audioBase64 ?? "", "base64")),
            contentType: mimeOfFormat(format),
            measure: Math.max(1, Math.ceil(secs)),
          };
          used = cand;
          break;
        }
        lastFail = {
          ok: false,
          httpStatus: r.error?.status ?? 502,
          code: r.error?.code ?? "upstream_error",
          message: r.error?.message ?? "Upstream audio service error",
        };
        if ((r.error?.status ?? 502) < 500) break;
        continue;
      }

      // ── 异步长文本：submit → query 轮询 → 立即转存本地 ──
      const sub = await callBytedanceTtsSubmit({
        apiBase: cand.apiBase,
        apiKey: cand.apiKey,
        resourceId: bdCfg!.resourceId!,
        requestId: randomUUID(),
        body: buildSubmitBody({
          userId: user.id,
          text: input,
          voice: body.voice,
          format,
          sampleRate: body.sample_rate,
          speed: body.speed,
        }),
      });
      recordKeyOutcome(cand.vendorKeyId, sub.ok, sub.ok ? 200 : sub.status || 502);
      if (!sub.ok) {
        lastFail = {
          ok: false,
          httpStatus: sub.error?.status ?? 502,
          code: sub.error?.code ?? "upstream_error",
          message: sub.error?.message ?? "Upstream submit failed",
        };
        if ((sub.error?.status ?? 502) < 500) break;
        continue;
      }

      const wait = await waitBytedanceTtsTask({
        apiBase: cand.apiBase,
        apiKey: cand.apiKey,
        resourceId: bdCfg!.resourceId!,
        taskId: sub.taskId!,
        requestId: randomUUID(),
      });
      if (!wait.ok) {
        // 任务已提交，换 Key 重交会重复计费；直接按失败收口
        lastFail = {
          ok: false,
          httpStatus: wait.error?.status ?? 502,
          code: wait.error?.code ?? "upstream_error",
          message: wait.error?.message ?? "Upstream task failed",
        };
        break;
      }

      // 拿到下载链接立即下载并转存本地（禁止长期引用上游 1 小时链接）
      let bytes: Buffer;
      try {
        const dl = await fetchBytes(wait.audioUrl!);
        bytes = dl.bytes;
      } catch (e) {
        lastFail = { ok: false, httpStatus: 502, code: "upstream_error", message: `音频转存下载失败：${(e as Error).message}` };
        break;
      }

      const ext = extOfFormat(format);
      let assetUrl: string | undefined;
      try {
        const saved = await saveUpload(kindForExt(ext), ext, bytes);
        assetUrl = saved.url;
      } catch (e) {
        // 落盘失败不阻塞交付；只在日志留痕，绝不落上游临时链接
        console.error(`[audio.speech] 本地转存失败 task=${sub.taskId}`, e);
      }

      outcome = {
        ok: true,
        bytes: new Uint8Array(bytes),
        contentType: mimeOfFormat(format),
        measure: Math.max(1, wait.reqTextLength ?? sub.reqTextLength ?? input.length),
        assetUrl,
      };
      used = cand;
      break;
    } catch (e) {
      releaseKeyProbe(cand.vendorKeyId); // 异常退出也要归还探测名额
      throw e;
    }
  }

  if (!outcome || !outcome.ok || !used) {
    releaseAll();
    await billing.refund(user.id, requestId);
    await recordUsage({ ...baseUsage, vendorKeyId: null, status: "failed", costMilli: 0, paidCredits: 0 });
    const fail = lastFail;
    const type = fail.httpStatus === 429 ? "rate_limit_error" : fail.httpStatus >= 500 ? "api_error" : "invalid_request_error";
    return gatewayError(fail.code, { status: fail.httpStatus, message: fail.message, type });
  }

  // ── 9. 结算：按实际用量（create 按秒 / submit 按字符） ──
  const actualCredits = displayMemberCredits(pricing, outcome.measure, 0);
  await billing.settle(user.id, requestId, actualCredits, apiKeyId);
  releaseAll();
  const usageId = await recordUsage({
    ...baseUsage,
    vendorKeyId: used.vendorKeyId,
    unitCount: outcome.measure,
    costMilli: costMilli(outcome.measure, pricing, "input"),
    paidCredits: actualCredits,
    status: "success",
    ...pricingSnapshot(pricing),
  });

  // 异步产物：库里只存本地地址（storageKey），sourceUrl 不落库
  if (outcome.assetUrl) {
    try {
      await db.generatedAsset.create({
        data: {
          userId: user.id,
          usageRecordId: usageId,
          // TTS 语音单独归类为 speech（区别于音乐/音效）
          assetType: "speech",
          // 只记真实文件头嗅探出的 MIME；嗅探不出保持 NULL
          mimeType: sniffMediaType(Buffer.from(outcome.bytes))?.mime ?? null,
          storageKey: outcome.assetUrl,
          sizeBytes: BigInt(outcome.bytes.byteLength),
          status: "temp",
          expireAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        },
      });
    } catch (e) {
      console.error(`[audio.speech] 写入 generated_asset 失败 requestId=${requestId}`, e);
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": outcome.contentType,
    "Cache-Control": "no-store",
  };
  if (outcome.assetUrl) headers["X-Asset-Url"] = outcome.assetUrl;

  // slice() 复制出独立且精确长度的 ArrayBuffer（避开 Node Buffer 小对象池导致的多余字节）
  return new NextResponse(outcome.bytes.slice().buffer as ArrayBuffer, { status: 200, headers });
}
