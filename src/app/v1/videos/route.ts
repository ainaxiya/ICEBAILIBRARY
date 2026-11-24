import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authenticateV1 } from "@/lib/gateway/auth";
import { isModelAllowedForAuth } from "@/lib/gateway/model-access";
import { billing, rechargeUrlFor } from "@/lib/gateway/billing";
import { minBalanceCreditsFor } from "@/lib/gateway/credits-gate";
import { apiError, gatewayError } from "@/lib/gateway/errors";
import { resolveRequestId } from "@/lib/gateway/idempotency";
import {
  pricingSnapshot,
  videoPricingForVariant,
  videoTaskMemberCredits,
  videoVariantFromBody,
} from "@/lib/gateway/pricing";
import { resolveRoute } from "@/lib/gateway/router";
import { requestGatewayBase } from "@/lib/gateway/gateway-routes";
import { runVideoTask, unitsForTask } from "@/lib/gateway/video-task";
import { enqueueVideoTask, queueEnabled } from "@/lib/queue/video-queue";
import { recordUsage, type UsageInput } from "@/lib/gateway/usage";
import { acquireSlot, checkKeyRpm, checkQuota, getQuotaConfig } from "@/lib/quota";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// ─── POST /v1/videos —— P6 #19 异步视频生成（OpenAI 风格 task_id） ───
// 流程：鉴权 → 校验 → 配额 → 预检（endpointType=video + video_generations 端点）
//   → 幂等（requestId 查已有任务直接返回）→ 门槛/预扣 → 并发控制（移交后台任务）
//   → 创建 VideoTask（queued）→ 立即返回 {task_id, status}
//   → 后台执行（REDIS_URL 配置时走 BullMQ 队列由任意实例的 Worker 消费，
//     未配置/入队失败回退进程内 inline 执行）
// 客户端轮询：GET /v1/videos/{task_id}
// Idempotency-Key：重试返回同一任务，不重复扣费。

const videoSchema = z
  .object({
    model: z.string().min(1),
    prompt: z.string().min(1),
    n: z.number().int().min(1).max(10).optional(),
    // 视频时长（秒，video_second 计价用）
    duration: z.number().min(1).max(600).optional(),
  })
  .passthrough();

const SITE_BASE = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/+$/, "");

export async function POST(req: NextRequest) {
  // ── 1. 鉴权 ──
  const auth = await authenticateV1(req);
  if (!auth.ok) {
    return apiError(auth.status, auth.message, "authentication_error", auth.code);
  }
  const user = auth.user;
  const channel = auth.channel;
  const apiKeyId = auth.apiKeyId;
  // 轮询地址必须回到调用方正在用的网关域名（已过白名单），不能用主站域名
  const gatewayBase = requestGatewayBase(req) || SITE_BASE;
  const pollUrl = (taskId: string) => `${gatewayBase}/v1/videos/${taskId}`;
  const noStore = { "Cache-Control": "no-store" } as const;

  // ── 2. 请求体校验 ──
  const raw = await req.json().catch(() => null);
  const parsed = videoSchema.safeParse(raw);
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
  if (route.model.endpointType !== "video") {
    return gatewayError("endpoint_disabled", { message: "This model does not support the videos endpoint" });
  }
  const endpoint = route.endpoints.find((e) => e.path === "video_generations" && e.enabled);
  if (!endpoint) {
    return gatewayError("endpoint_disabled", { message: "This model does not support the video_generations endpoint" });
  }
  // 视频按秒计价：分辨率档位价优先（如 720p:n / 720p:v），档位留空回退统一秒价；
  // 两者都留空 = 未定价，直接拒绝，不按最低 1 分兜底。
  const pricing = videoPricingForVariant(route, videoVariantFromBody(body as Record<string, unknown>));
  if (!pricing) {
    return gatewayError("pricing_not_configured");
  }
  const durationSec = body.duration ?? 5;
  const estUnits = unitsForTask(pricing, body.n ?? 1, durationSec);
  const estCredits = videoTaskMemberCredits(pricing, estUnits);
  if (estCredits == null) {
    return gatewayError("pricing_not_configured");
  }
  // 任务式上游：OpenAI 兼容（同步轮询 /videos）或火山方舟（contents/generations/tasks）
  if (route.vendor.protocol !== "openai" && route.vendor.protocol !== "ark") {
    return gatewayError("endpoint_unsupported", { message: "Upstream protocol does not support async video tasks" });
  }

  // S0-4：Idempotency-Key → 计费幂等 requestId；重试返回同一任务
  // L1：绑定端点 + 模型 + 请求体指纹，防止同一 Key 跨端点/换参数复用旧扣费与旧任务
  const requestId = resolveRequestId(user.id, req, { endpoint: "videos", model: body.model, body });
  const existed = await db.videoTask.findUnique({ where: { requestId } });
  if (existed) {
    return NextResponse.json(
      {
        task_id: existed.taskId,
        status: existed.status,
        progress: existed.progress,
        created_at: existed.createdAt.toISOString(),
        poll: pollUrl(existed.taskId),
      },
      { status: 200, headers: noStore }
    );
  }

  // 幂等收口：同 Key 的上一轮请求若已全额退款（建任务失败 / 并发超限 / 无可用 Key），
  // 预扣已回滚，此时重放不能被当成「已扣过」而免费建任务；明确要求换新 Idempotency-Key。
  const priorDecision = await db.creditLedger.findUnique({ where: { requestId: `${requestId}:decision` } });
  if (priorDecision?.refId === "refund") {
    return gatewayError("idempotency_key_refunded", {
      status: 409,
      message: "This Idempotency-Key was already refunded after a failed attempt. Retry with a new Idempotency-Key.",
    });
  }

  const started = Date.now();

  const baseUsage: Omit<UsageInput, "status" | "costMilli" | "paidCredits" | "vendorKeyId"> = {
    requestId,
    userId: user.id,
    channel,
    apiKeyId,
    modelId: route.model.id,
    endpointType: "video",
    modelSnapshot: body.model,
    promptTokens: 0,
    outputTokens: 0,
  };

  // 候选上游 Key（只落 id，不落明文）与定价快照：写进 payload v2，供队列对账重投时重建执行上下文
  const candidates = route.candidates.slice(0, 3);
  const pricingSnap: Record<string, string | number | null> = {
    id: pricing.id,
    meterBase: pricing.meterBase,
    unit: pricing.unit,
    inputPrice: String(pricing.inputPrice),
    outputPrice: String(pricing.outputPrice),
    currency: pricing.currency,
    fxRateE8: String(pricing.fxRateE8),
    multiplierBps: pricing.multiplierBps,
    memberInputPrice: pricing.memberInputPrice == null ? null : String(pricing.memberInputPrice),
    memberOutputPrice: pricing.memberOutputPrice == null ? null : String(pricing.memberOutputPrice),
  };

  // ── 5. 门槛（系列准入余额 + <200 分禁视频）+ 条件预扣 ──
  const minBalance = minBalanceCreditsFor(route.model);
  const pre = await billing.preCheck(user.id, estCredits, "video", minBalance, apiKeyId);
  if (!pre.ok) {
    if (pre.code === "min_balance_required") {
      const why = `${route.model.displayName || route.model.name} 系列要求账户积分不低于 ${pre.required} 才能使用`;
      return gatewayError("min_balance_required", {
        message: why,
        extra: {
          required_credits: pre.required,
          balance: pre.balance,
          recharge_url: rechargeUrlFor("/playground"),
        },
      });
    }
    return pre.code === "key_quota_exceeded"
      ? gatewayError("key_quota_exceeded", { message: pre.error || undefined })
      : gatewayError("insufficient_credits", { message: pre.error || undefined });
  }
  // g19：只有 seedance 保留预扣（强制选秒数，金额可精确到秒）；其余视频成功后按实际结算
  const preDeductEnabled = /seedance/i.test(route.model.name);
  if (preDeductEnabled) {
    const deduct = await billing.preDeduct(user.id, estCredits, requestId, apiKeyId);
    if (!deduct.ok) {
      return deduct.code === "key_quota_exceeded"
        ? gatewayError("key_quota_exceeded", { message: deduct.error || undefined })
        : gatewayError("insufficient_credits", { message: deduct.error || undefined });
    }
  }

  // ── 6. 并发控制（超限退款 429；任务终态归还额度） ──
  // 队列模式（REDIS_URL）：按 DB 在飞任务数计数，跨实例生效；
  // inline 模式：沿用进程内内存并发槽（本地开发 / E2E 行为不变）。
  const quotaCfg = await getQuotaConfig();
  let slotRelease: () => void = () => {};
  if (queueEnabled()) {
    const inflight = await db.videoTask.count({
      where: { userId: user.id, status: { in: ["queued", "processing"] } },
    });
    if (inflight >= quotaCfg.concurrency) {
      await billing.refund(user.id, requestId);
      return gatewayError("concurrency_exceeded");
    }
  } else {
    const slot = await acquireSlot(user.id, quotaCfg.concurrency);
    if (!slot.ok) {
      await billing.refund(user.id, requestId);
      return gatewayError("concurrency_exceeded");
    }
    slotRelease = slot.release;
  }

  // ── 7. 无可用 Key：退款 502 ──
  if (candidates.length === 0) {
    slotRelease();
    await billing.refund(user.id, requestId);
    await recordUsage({ ...baseUsage, vendorKeyId: null, status: "failed", costMilli: 0, paidCredits: 0, latencyMs: Date.now() - started });
    return gatewayError("no_upstream_key");
  }

  // ── 8. 创建任务（queued）→ 立即返回 → 后台执行 ──
  const taskId = `vt-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  // 建任务失败必须回滚：预扣全额退回，并返回明确错误（否则用户被扣分却拿不到任务）
  let task: Awaited<ReturnType<typeof db.videoTask.create>>;
  try {
    task = await db.videoTask.create({
      data: {
        taskId,
        requestId,
        userId: user.id,
        apiKeyId: apiKeyId == null ? null : BigInt(apiKeyId),
        channel,
        modelId: route.model.id,
        modelSnapshot: body.model,
        status: "queued",
        // payload v2：队列对账重投时据此重建执行上下文（只有 Key id，不含明文密钥）
        payload: JSON.stringify({
          v: 2,
          body,
          pricing: pricingSnap,
          baseUsage,
          durationSec,
          started,
          vendorKeyIds: candidates.map((c) => c.vendorKeyId),
        }),
      },
    });
  } catch (e) {
    // 并发同 Idempotency-Key：另一半已建成任务（P2002）。此时预扣是同一条 requestId，
    // 绝不能退款（会把对方的任务退成免费），直接幂等返回已有任务。
    if ((e as { code?: string })?.code === "P2002") {
      const dup = await db.videoTask.findUnique({ where: { requestId } });
      if (dup) {
        slotRelease();
        return NextResponse.json(
          {
            task_id: dup.taskId,
            status: dup.status,
            progress: dup.progress,
            created_at: dup.createdAt.toISOString(),
            poll: pollUrl(dup.taskId),
          },
          { status: 200, headers: noStore }
        );
      }
    }
    console.error("[videos] 创建任务失败，已预扣积分全额退回:", e);
    slotRelease();
    await billing.refund(user.id, requestId);
    await recordUsage({
      ...baseUsage,
      vendorKeyId: null,
      status: "failed",
      costMilli: 0,
      paidCredits: 0,
      latencyMs: Date.now() - started,
    });
    return gatewayError("task_create_failed", {
      message: "Failed to create the video task. The reserved credits have been refunded.",
      requestId,
    });
  }

  // 状态机/计费/转存全在执行器内闭环（异常自兜底）
  // 队列模式：入队（jobId=taskId 幂等），入队失败（Redis 抖动）回退 inline，任务绝不滞留
  if (queueEnabled()) {
    const enqueued = await enqueueVideoTask({
      taskId,
      // 队列只放 Key id（不放明文 apiKey），Worker 消费时再解密
      vendorKeyIds: candidates.map((c) => c.vendorKeyId),
      body: body as Record<string, unknown>,
      baseUsage,
      pricing: pricingSnap,
      durationSec,
      started,
    });
    if (!enqueued.ok) {
      console.error("[videos] BullMQ 入队失败，回退 inline:", enqueued.error);
      void runVideoTask({
        taskId,
        candidates,
        body: body as Record<string, unknown>,
        baseUsage,
        pricing,
        unitsFor: (count) => unitsForTask(pricing, count, durationSec),
        started,
        slotRelease,
      }).catch(() => {});
    }
  } else {
    void runVideoTask({
      taskId,
      candidates,
      body: body as Record<string, unknown>,
      baseUsage,
      pricing,
      unitsFor: (count) => unitsForTask(pricing, count, durationSec),
      started,
      slotRelease,
    }).catch(() => {});
  }

  return NextResponse.json(
    {
      task_id: task.taskId,
      status: task.status,
      progress: task.progress,
      created_at: task.createdAt.toISOString(),
      // 便捷字段：客户端可直接拼 GET 轮询地址（网关域名，已过白名单）
      poll: pollUrl(task.taskId),
    },
    { status: 202, headers: noStore }
  );
}
