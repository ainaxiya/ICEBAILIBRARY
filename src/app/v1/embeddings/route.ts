import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateV1 } from "@/lib/gateway/auth";
import { isModelAllowedForAuth } from "@/lib/gateway/model-access";
import { billing } from "@/lib/gateway/billing";
import { apiError, gatewayError } from "@/lib/gateway/errors";
import { resolveRequestId } from "@/lib/gateway/idempotency";
import {
  beginIdempotentRequest,
  hasClientIdempotencyKey,
  releaseIdempotentRequest,
  saveIdempotentResponse,
} from "@/lib/gateway/response-cache";
import { callEmbeddings } from "@/lib/gateway/adapters/embeddings";
import { costMilli, displayMemberCredits, pricingSnapshot } from "@/lib/gateway/pricing";
import { markKeyUsed, recordKeyCancelled, recordKeyOutcome, releaseKeyProbe, resolveRoute, tryAcquireKeyCall, type KeyCandidate } from "@/lib/gateway/router";
import { recordUsage, type UsageInput } from "@/lib/gateway/usage";
import { acquireSlot, checkKeyRpm, checkQuota, getQuotaConfig } from "@/lib/quota";

export const dynamic = "force-dynamic";

// ─── POST /v1/embeddings —— P4 多模态：文本向量化（OpenAI 兼容） ───
// 按厂商 protocol 分发：openai 透传 / gemini 转换 batchEmbedContents / anthropic 不支持 400。
// 计费：按 input tokens（输出侧为 0），流程与 chat 一致：鉴权 → 预检 → 预扣 → adapter
//   → 结算（实际 tokens ceil）→ 上游失败换 Key 重试（最多 3 个），最终失败全额退回 + 502。

const embedSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.string())]),
    encoding_format: z.string().optional(),
  })
  .passthrough();

// 统一错误体（P1 契约）：由 gateway/errors.ts 提供

export async function POST(req: NextRequest) {
  // ── 1. 鉴权 ──
  const auth = await authenticateV1(req);
  if (!auth.ok) {
    return apiError(auth.status, auth.message, "authentication_error", auth.code);
  }
  const user = auth.user;
  const channel = auth.channel;
  const apiKeyId = auth.apiKeyId;

  // ── 2. 请求体校验 ──
  const raw = await req.json().catch(() => null);
  const parsed = embedSchema.safeParse(raw);
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
  const texts = typeof body.input === "string" ? [body.input] : body.input;

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

  // ── 4. 预检：模型 / 端点（endpointType=embedding + path=embeddings）/ 定价 ──
  const route = await resolveRoute(body.model);
  if (!route) {
    return gatewayError("model_not_found");
  }
  if (route.model.endpointType !== "embedding") {
    return gatewayError("endpoint_disabled", { message: "This model does not support the embeddings endpoint" });
  }
  const endpoint = route.endpoints.find((e) => e.path === "embeddings" && e.enabled);
  if (!endpoint) {
    return gatewayError("endpoint_disabled", { message: "This model does not support the embeddings endpoint" });
  }
  const pricing = route.pricing;
  if (!pricing) {
    return gatewayError("pricing_not_configured");
  }
  // Anthropic 上游无 embeddings 能力：明确 400（不进计费流程）
  if (route.vendor.protocol === "anthropic") {
    return gatewayError("endpoint_unsupported", { message: "Upstream protocol does not support embeddings" });
  }

  // L1：绑定端点 + 模型 + 请求体指纹，防止同一 Key 跨端点/换参数复用旧扣费
  const requestId = resolveRequestId(user.id, req, { endpoint: "embeddings", model: body.model, body });
  const started = Date.now();

  // ── 4.5 响应级幂等：同 Key 的已完成请求直接回放（不重复调上游、不重复扣费） ──
  const keyed = hasClientIdempotencyKey(req);
  const idem = await beginIdempotentRequest({ requestId, userId: user.id, endpoint: "embeddings", keyed });
  if (idem.kind === "replay") {
    return NextResponse.json(idem.body as Record<string, unknown>, {
      status: idem.status,
      headers: { "Cache-Control": "no-store", "Idempotent-Replayed": "true" },
    });
  }
  if (idem.kind === "in_progress") {
    return gatewayError("request_in_progress", {
      message: "A request with this Idempotency-Key is still in progress. Retry after the interval.",
      requestId,
      headers: { "Retry-After": String(idem.retryAfterSec) },
    });
  }
  // 失败/中断释放幂等记录（只缓存成功）
  const fail = async (status: number, message: string, type: string, code: string) => {
    if (keyed) await releaseIdempotentRequest(requestId);
    return gatewayError(code, { status, message, type, requestId });
  };
  // 粗估 input tokens（≈4 字符 1 token）：embeddings 只有输入侧
  const estInput = Math.ceil(JSON.stringify(texts).length / 4);
  const estCredits = displayMemberCredits(pricing, estInput, 0);

  const baseUsage: Omit<UsageInput, "status" | "costMilli" | "paidCredits" | "vendorKeyId"> = {
    requestId,
    userId: user.id,
    channel,
    apiKeyId,
    modelId: route.model.id,
    endpointType: "embedding",
    modelSnapshot: body.model,
    promptTokens: 0,
    outputTokens: 0,
  };

  // ── 5. 余额预检（g19：不预扣，成功后按实际结算） ──
  const pre = await billing.preCheck(user.id, estCredits, "embedding", 0, apiKeyId);
  if (!pre.ok) {
    return pre.code === "key_quota_exceeded"
      ? fail(402, pre.error || "API key quota exceeded", "insufficient_quota", "key_quota_exceeded")
      : fail(402, pre.error || "Insufficient credits", "insufficient_quota", "insufficient_credits");
  }

  // ── 6. 并发槽 ──
  const quotaCfg = await getQuotaConfig();
  const slot = await acquireSlot(user.id, quotaCfg.concurrency);
  if (!slot.ok) {
    await billing.refund(user.id, requestId);
    return fail(429, "Too many concurrent requests. Please retry later", "rate_limit_error", "concurrency_exceeded");
  }

  // ── 7. 路由选 Key + adapter 调用（失败换下一个，最多 3 个） ──
  const attempts: KeyCandidate[] = route.candidates.slice(0, 3);
  if (attempts.length === 0) {
    slot.release();
    await billing.refund(user.id, requestId);
    await recordUsage({ ...baseUsage, vendorKeyId: null, status: "failed", costMilli: 0, paidCredits: 0, latencyMs: Date.now() - started });
    return fail(502, "No upstream channel available for this model", "api_error", "no_upstream_key");
  }

  let result: Awaited<ReturnType<typeof callEmbeddings>> | null = null;
  let used: KeyCandidate | null = null;
  let lastError = "";
  let cancelled = false;
  // 客户端取消传播：断连 → abort 上游 fetch
  const ac = new AbortController();
  const onClientAbort = () => ac.abort();
  req.signal?.addEventListener("abort", onClientAbort, { once: true });
  for (const cand of attempts) {
    if (ac.signal.aborted) break;
    // U2：真正调用前才占用半开探测名额；名额已被占用则跳过该 Key
    if (!tryAcquireKeyCall(cand.vendorKeyId)) continue;
    markKeyUsed(cand.vendorKeyId);
    let r: Awaited<ReturnType<typeof callEmbeddings>>;
    try {
      r = await callEmbeddings({ protocol: route.vendor.protocol, apiBase: cand.apiBase, apiKey: cand.apiKey, body: body as Record<string, unknown>, signal: ac.signal });
    } catch (e) {
      releaseKeyProbe(cand.vendorKeyId); // 异常退出也要归还探测名额
      throw e;
    }
    // 客户端主动断连不算上游失败：不进熔断窗口、不推高失败率
    if (r.aborted) {
      recordKeyCancelled(cand.vendorKeyId);
      cancelled = true;
      break;
    }
    recordKeyOutcome(cand.vendorKeyId, r.ok, r.ok ? 200 : r.status || 502);
    if (r.ok) {
      result = r;
      used = cand;
      break;
    }
    lastError = r.errorMessage || `HTTP ${r.status}`;
  }

  // 客户端在等待阶段断连：向量未交付，全额退
  if (cancelled) {
    req.signal?.removeEventListener("abort", onClientAbort);
    slot.release();
    await billing.refund(user.id, requestId);
    await recordUsage({ ...baseUsage, vendorKeyId: null, status: "cancelled", costMilli: 0, paidCredits: 0, latencyMs: Date.now() - started });
    return fail(499, "Client closed request", "cancelled_error", "client_cancelled");
  }

  if (!result || !used) {
    // 断连发生在首次尝试前：按取消收口，不记失败
    const clientGone = ac.signal.aborted;
    req.signal?.removeEventListener("abort", onClientAbort);
    slot.release();
    await billing.refund(user.id, requestId);
    await recordUsage({
      ...baseUsage,
      vendorKeyId: null,
      status: clientGone ? "cancelled" : "failed",
      costMilli: 0,
      paidCredits: 0,
      latencyMs: Date.now() - started,
    });
    if (clientGone) return fail(499, "Client closed request", "cancelled_error", "client_cancelled");
    return fail(502, `Upstream embedding service error: ${lastError}`, "api_error", "upstream_error");
  }

  // ── 8. 结算：按实际 input tokens ceil 整数积分（预扣多退少补，输出侧 0） ──
  const tokens = Math.max(0, result.promptTokens);
  const paid = displayMemberCredits(pricing, tokens, 0);
  await billing.settle(user.id, requestId, paid, apiKeyId);
  req.signal?.removeEventListener("abort", onClientAbort);
  slot.release();
  await recordUsage({
    ...baseUsage,
    vendorKeyId: used.vendorKeyId,
    promptTokens: tokens,
    outputTokens: 0,
    costMilli: costMilli(tokens, pricing, "input"), // 内部成本毫积分（毛利报表）
    paidCredits: paid,
    latencyMs: Date.now() - started,
    status: "success",
    ...pricingSnapshot(pricing),
  });

  const payload = (result.json ?? {}) as Record<string, unknown>;
  // 只缓存成功响应（向量量大时超过上限会自动跳过缓存）
  if (keyed) await saveIdempotentResponse(requestId, 200, payload);
  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
}
