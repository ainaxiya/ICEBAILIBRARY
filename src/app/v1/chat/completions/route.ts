import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateV1 } from "@/lib/gateway/auth";
import { billing } from "@/lib/gateway/billing";
import { resolveRequestId } from "@/lib/gateway/idempotency";
import { callChatCompletions } from "@/lib/gateway/adapters/openai";
import { displayMemberCredits, estimateCredits, totalCostMilli } from "@/lib/gateway/pricing";
import { markKeyUsed, resolveRoute, type KeyCandidate, type RouteContext } from "@/lib/gateway/router";
import { recordUsage, type UsageInput } from "@/lib/gateway/usage";
import { acquireSlot, checkKeyRpm, checkQuota, getQuotaConfig } from "@/lib/quota";

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

// OpenAI 风格错误体
function apiError(status: number, message: string, type: string, code: string) {
  return NextResponse.json({ error: { message, type, code } }, { status });
}

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
    return apiError(400, "Invalid request body: " + parsed.error.issues[0]?.message, "invalid_request_error", "invalid_body");
  }
  const body = parsed.data;

  // ── 3. 配额（超限 429）──
  // apikey 通道：只做 Key 层 RPM（会员层日次数放宽）；onsite 通道：会员层日次数 + RPM
  if (channel === "apikey") {
    const keyQuota = checkKeyRpm(apiKeyId!);
    if (!keyQuota.ok) {
      return apiError(429, keyQuota.error || "Rate limit exceeded. Please slow down and retry later", "rate_limit_error", "quota_exceeded");
    }
  } else {
    const quota = await checkQuota(user.id);
    if (!quota.ok) {
      return apiError(429, quota.error || "Rate limit exceeded. Please slow down and retry later", "rate_limit_error", "quota_exceeded");
    }
  }

  // ── 4. 预检：模型 / 端点 / 定价 ──
  const route = await resolveRoute(body.model);
  if (!route) {
    return apiError(404, "Model not found or offline", "invalid_request_error", "model_not_found");
  }
  const endpoint = route.endpoints.find((e) => e.path === "chat_completions" && e.enabled);
  if (!endpoint) {
    return apiError(404, "This model does not support the chat_completions endpoint", "invalid_request_error", "endpoint_disabled");
  }
  const pricing = route.pricing;
  if (!pricing) {
    return apiError(404, "Model pricing is not configured", "invalid_request_error", "pricing_not_configured");
  }

  // S0-4：客户端 Idempotency-Key → 计费幂等 requestId（重试不重复扣费）
  const requestId = resolveRequestId(user.id, req);
  const started = Date.now();
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

  // 余额类拒绝 402（含 <200 分禁生图/生视频门槛，本端点为 chat）
  const pre = await billing.preCheck(user.id, estCredits, "chat");
  if (!pre.ok) {
    return apiError(402, pre.error || "Insufficient credits", "insufficient_quota", "insufficient_credits");
  }

  // ── 5. 预扣（request_id 幂等） ──
  const deduct = await billing.preDeduct(user.id, estCredits, requestId);
  if (!deduct.ok) {
    return apiError(402, deduct.error || "Insufficient credits", "insufficient_quota", "insufficient_credits");
  }

  // ── 6. 并发槽（超限退回预扣并 429；出口路径必须 release） ──
  const quotaCfg = await getQuotaConfig();
  const slot = acquireSlot(user.id, quotaCfg.concurrency);
  if (!slot.ok) {
    await billing.refund(user.id, requestId);
    return apiError(429, "Too many concurrent requests. Please retry later", "rate_limit_error", "concurrency_exceeded");
  }

  // ── 7. 路由选 Key + adapter 调用（失败换下一个，最多 3 个） ──
  const attempts: KeyCandidate[] = route.candidates.slice(0, 3);
  if (attempts.length === 0) {
    slot.release();
    await billing.refund(user.id, requestId);
    await recordUsage({ ...baseUsage, vendorKeyId: null, status: "failed", costMilli: 0, paidCredits: 0, latencyMs: Date.now() - started });
    return apiError(502, "No upstream channel available for this model", "api_error", "no_upstream_key");
  }

  let result = null as Awaited<ReturnType<typeof callChatCompletions>> | null;
  let used: KeyCandidate | null = null;
  let lastError = "";
  for (const cand of attempts) {
    markKeyUsed(cand.vendorKeyId);
    const r = await callChatCompletions({ apiBase: cand.apiBase, apiKey: cand.apiKey, body: body as Record<string, unknown> });
    if (r.ok) {
      result = r;
      used = cand;
      break;
    }
    lastError = r.errorMessage || `HTTP ${r.status}`;
  }

  // 全部 Key 失败：全额退回 + 502
  if (!result || !used) {
    slot.release();
    await billing.refund(user.id, requestId);
    await recordUsage({ ...baseUsage, vendorKeyId: null, status: "failed", costMilli: 0, paidCredits: 0, latencyMs: Date.now() - started });
    return apiError(502, `Upstream model service error: ${lastError}`, "api_error", "upstream_error");
  }

  // ── 8. 结算：实际用量 ceil 整数积分（写 usage_record.paid_credits / cost_milli） ──
  const settleOnce = async (status: "success" | "failed") => {
    try {
      const usage = result!.usageRef.current || { promptTokens: estInput, completionTokens: 0 };
      const costM = totalCostMilli(pricing, usage.promptTokens, usage.completionTokens);
      // v0.96 直观定价：按输入/输出会员价结算（未填则回退 成本×加价系数）
      const paid = displayMemberCredits(pricing, usage.promptTokens, usage.completionTokens);
      if (status === "success") {
        await billing.settle(user.id, requestId, paid);
      } else {
        await billing.refund(user.id, requestId);
      }
      await recordUsage({
        ...baseUsage,
        vendorKeyId: used!.vendorKeyId,
        promptTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
        costMilli: costM,
        // 失败全额退回：实扣记 0
        paidCredits: status === "success" ? paid : 0,
        latencyMs: Date.now() - started,
        status,
      });
    } finally {
      slot.release();
    }
  };

  // ── 9. 响应 ──
  // 非流式：整包 JSON 透传
  if (!body.stream) {
    await settleOnce("success");
    return NextResponse.json(result.json ?? {});
  }

  // 流式：SSE 逐块透传（text/event-stream），结束时结算
  const upstreamStream = result.stream!;
  const reader = upstreamStream.getReader();
  let finalized = false;
  const finalize = async (status: "success" | "failed") => {
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
        await finalize("failed");
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      await finalize("failed");
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
