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
import { callChatForProtocol } from "@/lib/gateway/adapters";
import { checkChatParams } from "@/lib/gateway/capabilities";
import { displayMemberCredits, estimateCredits, pricingSnapshot, totalCostMilli } from "@/lib/gateway/pricing";
import { markKeyUsed, recordKeyCancelled, recordKeyOutcome, releaseKeyProbe, resolveRoute, tryAcquireKeyCall, type KeyCandidate, type RouteContext } from "@/lib/gateway/router";
import { recordUsage, type UsageInput } from "@/lib/gateway/usage";
import { acquireSlot, checkKeyRpm, checkQuota, getQuotaConfig } from "@/lib/quota";
import { acquireChannel } from "@/lib/queue/channel-gate";

export const dynamic = "force-dynamic";

// ─── POST /v1/chat/completions —— P1 原生聚合网关（OpenAI 兼容） ───
// 流程（方案 6.1）：鉴权 → 预检（模型/端点/余额）→ 预扣（request_id 幂等）
//   → 路由选 Key → adapter 调用（SSE 透传 / JSON）→ 结算（实际用量 ceil）
//   → 上游失败换 Key 重试（最多 3 个），最终失败全额退回 + 502
// 鉴权 P5 双通道：站内登录态（channel=onsite）；Bearer sk- 站外 Key（channel=apikey）。

const messageSchema = z
  .object({
    role: z.string().min(1),
    content: z.unknown().optional(),
  })
  .passthrough();

const chatSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    top_p: z.number().min(0).max(1).optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    user: z.string().optional(),
  })
  .passthrough();

// 统一错误体（P1 契约）：由 gateway/errors.ts 提供

export async function POST(req: NextRequest) {
  // ── 1. 鉴权（站内登录态 / 站外 Bearer sk- Key，见 gateway/auth） ──
  const auth = await authenticateV1(req);
  if (!auth.ok) {
    return apiError(auth.status, auth.message, "authentication_error", auth.code);
  }
  const user = auth.user;
  const channel = auth.channel;
  const apiKeyId = auth.apiKeyId;

  // ── 2. 请求体校验（OpenAI 兼容，core 字段 zod 校验，其余透传） ──
  const raw = await req.json().catch(() => null);
  const parsed = chatSchema.safeParse(raw);
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

  // ── 3. 配额（超限 429）──
  // apikey 通道：只做 Key 层 RPM（会员层日次数放宽）；onsite 通道：会员层日次数 + RPM
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

  // ── 4. 预检：模型 / 端点 / 定价 ──
  const route = await resolveRoute(body.model);
  if (!route) {
    return gatewayError("model_not_found");
  }
  const endpoint = route.endpoints.find((e) => e.path === "chat_completions" && e.enabled);
  if (!endpoint) {
    return gatewayError("endpoint_disabled", { message: "This model does not support the chat_completions endpoint" });
  }
  const pricing = route.pricing;
  if (!pricing) {
    return gatewayError("pricing_not_configured");
  }

  // ── 4.5 #17 能力协商：模型配置了参数白名单时，白名单外参数 400 指名（不静默降级） ──
  const capCheck = checkChatParams(route.model.capabilities, body as Record<string, unknown>);
  if (!capCheck.ok) {
    return gatewayError("unsupported_parameter", {
      message: `Model does not support parameter(s): ${capCheck.unsupported.join(", ")}`,
    });
  }

  // S0-4：客户端 Idempotency-Key → 计费幂等 requestId（重试不重复扣费）
  // L1：绑定端点 + 模型 + 请求体指纹，防止同一 Key 跨端点/换参数复用旧扣费
  const requestId = resolveRequestId(user.id, req, { endpoint: "chat.completions", model: body.model, body });
  const started = Date.now();

  // ── 4.5 响应级幂等（仅非流式）：同 Key 的已完成请求直接回放 ──
  // 流式不缓存：SSE 无法安全回放（分块时序/中途断连语义），且 token 已按上游实际用量结算。
  const keyed = hasClientIdempotencyKey(req) && !body.stream;
  if (keyed) {
    const idem = await beginIdempotentRequest({
      requestId,
      userId: user.id,
      endpoint: "chat.completions",
      keyed,
    });
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
  }
  // 失败/中断释放幂等记录（只缓存成功，失败不能让后续重试被 409 堵住）
  const fail = async (status: number, message: string, type: string, code: string) => {
    if (keyed) await releaseIdempotentRequest(requestId);
    return gatewayError(code, { status, message, type, requestId });
  };
  const estInput = Math.ceil(JSON.stringify(body.messages).length / 4);
  const estOutput = body.max_tokens ?? 1024;
  const estCredits = estimateCredits({ pricings: [pricing] }, { input: estInput, output: estOutput });

  const baseUsage: Omit<UsageInput, "status" | "costMilli" | "paidCredits" | "vendorKeyId"> = {
    requestId,
    userId: user.id,
    channel,
    apiKeyId, // 站外 Key（user_api_key.id）；站内为 null
    modelId: route.model.id,
    endpointType: "chat",
    modelSnapshot: body.model,
    promptTokens: 0,
    outputTokens: 0,
  };

  // 余额类拒绝 402（含 <200 分禁生图/生视频门槛，本端点为 chat）；g19：Key 额度只读预检
  const pre = await billing.preCheck(user.id, estCredits, "chat", 0, apiKeyId);
  if (!pre.ok) {
    return pre.code === "key_quota_exceeded"
      ? fail(402, pre.error || "API key quota exceeded", "insufficient_quota", "key_quota_exceeded")
      : fail(402, pre.error || "Insufficient credits", "insufficient_quota", "insufficient_credits");
  }

  // g19：文本不再预扣，成功后按实际用量结算（settle 内累加 Key 已用额度）

  // ── 6. 并发槽（超限退回预扣并 429；出口路径必须 release） ──
  const quotaCfg = await getQuotaConfig();
  const slot = await acquireSlot(user.id, quotaCfg.concurrency);
  if (!slot.ok) {
    await billing.refund(user.id, requestId);
    return fail(429, "Too many concurrent requests. Please retry later", "rate_limit_error", "concurrency_exceeded");
  }

  // ── 6.5 全站文本并发闸门（后台设置 queue_config.text，含流式）──
  // 超过上限的请求排队等待；等不到才退款并 429。音频走同机制的 audio 通道。
  const gate = await acquireChannel("text");
  if (!gate.ok) {
    slot.release();
    await billing.refund(user.id, requestId);
    return fail(429, "Text concurrency limit reached. Please retry later", "rate_limit_error", "text_concurrency_exceeded");
  }
  const releaseAll = () => {
    gate.release();
    slot.release();
  };

  // ── 7. 路由选 Key + adapter 调用（失败换下一个，最多 3 个） ──
  // P2 取消传播：客户端断连 → abort 上游 fetch（等待阶段）；流阶段由 stream.cancel 传播
  const ac = new AbortController();
  const onClientAbort = () => ac.abort();
  req.signal?.addEventListener("abort", onClientAbort, { once: true });

  const attempts: KeyCandidate[] = route.candidates.slice(0, 3);
  if (attempts.length === 0) {
    req.signal?.removeEventListener("abort", onClientAbort);
    releaseAll();
    await billing.refund(user.id, requestId);
    await recordUsage({ ...baseUsage, vendorKeyId: null, status: "failed", costMilli: 0, paidCredits: 0, latencyMs: Date.now() - started });
    return fail(502, "No upstream channel available for this model", "api_error", "no_upstream_key");
  }

  let result = null as Awaited<ReturnType<typeof callChatForProtocol>> | null;
  let used: KeyCandidate | null = null;
  let lastError = "";
  // 真正向上游发出过几次请求：等待阶段断连时据此区分「平台是否有成本」
  let upstreamCalls = 0;
  for (const cand of attempts) {
    // 客户端已断连（含进入本次调用前就断开）：不再消耗上游
    if (ac.signal.aborted || req.signal?.aborted) break;
    // U2：真正调用前才占用半开探测名额；名额已被占用则跳过该 Key
    if (!tryAcquireKeyCall(cand.vendorKeyId)) continue;
    markKeyUsed(cand.vendorKeyId);
    let r: Awaited<ReturnType<typeof callChatForProtocol>>;
    try {
      upstreamCalls++;
      // P4 多协议：按厂商 protocol 分发 adapter（openai/anthropic/gemini），输出统一 OpenAI 形状
      r = await callChatForProtocol({ protocol: route.vendor.protocol, apiBase: cand.apiBase, apiKey: cand.apiKey, body: body as Record<string, unknown>, signal: ac.signal });
    } catch (e) {
      releaseKeyProbe(cand.vendorKeyId); // 异常退出也要归还探测名额
      throw e;
    }
    // 客户端主动断连不算上游失败：不进熔断窗口、不推高失败率（aborted 由 adapter 三条件判定）
    if (r.aborted) {
      recordKeyCancelled(cand.vendorKeyId);
      break;
    }
    // P2 渠道健康：记录每次尝试结果（滑动窗口熔断依据）
    recordKeyOutcome(cand.vendorKeyId, r.ok, r.ok ? 200 : r.status || 502);
    if (r.ok) {
      result = r;
      used = cand;
      break;
    }
    lastError = r.errorMessage || `HTTP ${r.status}`;
  }

  // 客户端在等待阶段断连：按「是否已把请求发给上游」分两种口径
  //   ① 一次上游请求都没发出（abort 发生在调用前）：平台无成本 → 全额退回预扣
  //   ② 已发出但响应未知：上游很可能已按输入计费，全额退等于平台白担成本
  //      → 按已发送的输入 token 结算，输出部分不收费，差额自动退回
  if ((ac.signal.aborted || req.signal?.aborted) && !result) {
    req.signal?.removeEventListener("abort", onClientAbort);
    releaseAll();
    if (upstreamCalls === 0) {
      await billing.refund(user.id, requestId);
      // 客户端取消：不是上游失败，不污染失败率统计
      await recordUsage({ ...baseUsage, vendorKeyId: null, status: "cancelled", costMilli: 0, paidCredits: 0, latencyMs: Date.now() - started });
    } else {
      const held = displayMemberCredits(pricing, estInput, 0);
      await billing.settle(user.id, requestId, held, apiKeyId);
      await recordUsage({
        ...baseUsage,
        vendorKeyId: used?.vendorKeyId ?? null,
        promptTokens: estInput,
        outputTokens: 0,
        costMilli: totalCostMilli(pricing, estInput, 0),
        paidCredits: held,
        status: "cancelled",
        latencyMs: Date.now() - started,
        ...pricingSnapshot(pricing),
      });
    }
    return fail(499, "Client closed request", "cancelled_error", "client_cancelled");
  }

  // 全部 Key 失败：全额退回 + 502
  if (!result || !used) {
    req.signal?.removeEventListener("abort", onClientAbort);
    releaseAll();
    await billing.refund(user.id, requestId);
    await recordUsage({ ...baseUsage, vendorKeyId: null, status: "failed", costMilli: 0, paidCredits: 0, latencyMs: Date.now() - started });
    return fail(502, `Upstream model service error: ${lastError}`, "api_error", "upstream_error");
  }

  // ── 8. 结算：实际用量 ceil 整数积分（写 usage_record.paid_credits / cost_milli） ──
  // cancelled = 客户端中途断连：按「已发生用量」（上游 usage 或运行估算）结算，不全额退款（方案 7.4）
  const settleOnce = async (status: "success" | "failed" | "cancelled") => {
    try {
      const usage = result!.usageRef.current || { promptTokens: estInput, completionTokens: 0 };
      const costM = totalCostMilli(pricing, usage.promptTokens, usage.completionTokens);
      // v0.96 直观定价：按输入/输出会员价结算（未填则回退 成本×加价系数）
      const paid = displayMemberCredits(pricing, usage.promptTokens, usage.completionTokens);
      if (status === "failed") {
        await billing.refund(user.id, requestId);
      } else {
        await billing.settle(user.id, requestId, paid, apiKeyId);
      }
      // 渠道健康：cancelled 视作中性（取消不是上游质量信号），failed 记失败，success 记成功
      if (status === "cancelled") {
        recordKeyCancelled(used!.vendorKeyId);
      } else {
        recordKeyOutcome(used!.vendorKeyId, status !== "failed", status === "failed" ? 502 : 200);
      }
      await recordUsage({
        ...baseUsage,
        vendorKeyId: used!.vendorKeyId,
        promptTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
        costMilli: costM,
        // 失败全额退回：实扣记 0；成功/取消按实际结算
        paidCredits: status === "failed" ? 0 : paid,
        latencyMs: Date.now() - started,
        status,
        // P3 价格版本快照（调价不回写历史）
        ...pricingSnapshot(pricing),
      });
    } finally {
      req.signal?.removeEventListener("abort", onClientAbort);
      releaseAll();
    }
  };

  // ── 9. 响应 ──
  // 非流式：整包 JSON 透传（同 Key 重试直接回放这一份）
  if (!body.stream) {
    await settleOnce("success");
    const payload = (result.json ?? {}) as Record<string, unknown>;
    if (keyed) await saveIdempotentResponse(requestId, 200, payload);
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  }

  // 流式：SSE 逐块透传（text/event-stream），结束时结算
  const upstreamStream = result.stream!;
  const reader = upstreamStream.getReader();
  let finalized = false;
  const finalize = async (status: "success" | "failed" | "cancelled") => {
    if (finalized) return;
    finalized = true;
    await settleOnce(status).catch(() => {});
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value); // 逐块透传，不缓冲
        }
        controller.close();
        await finalize("success");
      } catch (e) {
        try {
          controller.error(e);
        } catch {}
        // 客户端已断连时读流报错属于取消，不是上游失败（熔断统计按中性处理）
        await finalize(ac.signal.aborted ? "cancelled" : "failed");
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      // P2：断连按已发生用量结算（运行估算在 usageRef 中），不再全额退款
      await finalize("cancelled");
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
