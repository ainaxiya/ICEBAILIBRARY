import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { ModelPricing } from "@prisma/client";
import { saveGeneratedAsset } from "@/lib/assets";
import type { AssetType } from "@/lib/asset-types";
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
import { callMediaGenerations } from "@/lib/gateway/adapters/media";
import { costMilli, displayMemberCredits, pricingSnapshot } from "@/lib/gateway/pricing";
import { markKeyUsed, recordKeyOutcome, releaseKeyProbe, resolveRoute, tryAcquireKeyCall, type KeyCandidate } from "@/lib/gateway/router";
import { recordUsage, type UsageInput } from "@/lib/gateway/usage";
import { acquireSlot, checkKeyRpm, checkQuota, getQuotaConfig } from "@/lib/quota";

export const dynamic = "force-dynamic";

// ─── POST /v1/images/generations —— P5 图/视频生成（OpenAI 兼容） ───
// 按模型 endpointType 分发：image → 同步 images/generations 风格 adapter，
// video → 异步任务（提交→轮询→取结果）adapter，一个路由内分发。
// 流程（方案 6.1）：鉴权 → 预检（模型/端点/定价）→ 门槛（<200 分禁图/视频 402）
//   → 预扣（request_id 幂等）→ 路由选 Key → adapter 调用
//   → 生成成功即转存默认存储桶（转存失败不退扣分，资产标 deleted 可重试拉取一次）
//   → 结算 ceil → 返回我们自己的 URL；上游失败换 Key 重试（最多 3 个），最终失败全额退回 + 502

const genSchema = z
  .object({
    model: z.string().min(1),
    prompt: z.string().min(1),
    n: z.number().int().min(1).max(10).optional(),
    // 视频时长（秒，per_video_second 计价用）
    duration: z.number().min(1).max(600).optional(),
  })
  .passthrough();

// 统一错误体（P1 契约）：由 gateway/errors.ts 提供

// 计量值：per_image=张数、per_video_second=秒×条数、per_request=1
function unitsFor(pricing: ModelPricing, count: number, durationSec: number): number {
  if (pricing.unit === "request") return 1;
  if (pricing.unit === "video_second") return Math.max(1, count) * Math.max(1, durationSec);
  return Math.max(1, count);
}

const SITE_BASE = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/+$/, "");

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
  const parsed = genSchema.safeParse(raw);
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

  // ── 3. 配额（apikey 通道只做 Key 层 RPM；onsite 通道会员层日次数/RPM） ──
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

  // ── 4. 预检：模型 / 端点 / 定价（endpointType 分发 image|video） ──
  const route = await resolveRoute(body.model);
  if (!route) {
    return gatewayError("model_not_found");
  }
  const modelKind = route.model.endpointType;
  if (modelKind !== "image" && modelKind !== "video") {
    return gatewayError("endpoint_disabled", { message: "This model does not support generation endpoints" });
  }
  const endpointPath = modelKind === "video" ? "video_generations" : "image_generations";
  const endpoint = route.endpoints.find((e) => e.path === endpointPath && e.enabled);
  if (!endpoint) {
    return gatewayError("endpoint_disabled", { message: `This model does not support the ${endpointPath} endpoint` });
  }
  const pricing = route.pricing;
  if (!pricing) {
    return gatewayError("pricing_not_configured");
  }

  // S0-4：客户端 Idempotency-Key → 计费幂等 requestId（重试不重复扣费）
  // L1：绑定端点（图/视频分开）+ 模型 + 请求体指纹，防止廉价 chat 的 Key 复用到生图
  const requestId = resolveRequestId(user.id, req, { endpoint: endpointPath, model: body.model, body });
  const started = Date.now();

  // ── 4.5 响应级幂等：同一 Idempotency-Key 的已完成请求直接回放 ──
  // 只回放成功响应；首个请求仍在执行 → 409 + Retry-After（不并排再打一次上游）。
  const keyed = hasClientIdempotencyKey(req);
  const idem = await beginIdempotentRequest({ requestId, userId: user.id, endpoint: endpointPath, keyed });
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
  // 失败/中断必须释放幂等记录，否则一次失败会把后续重试永久堵死
  const fail = async (status: number, message: string, type: string, code: string) => {
    if (keyed) await releaseIdempotentRequest(requestId);
    return gatewayError(code, { status, message, type, requestId });
  };

  const estUnits = unitsFor(pricing, body.n ?? 1, body.duration ?? 5);
  // v0.96 直观定价：图片/视频按「单位」计量走输入侧会员价（未填回退 成本×加价系数）
  const estCredits = displayMemberCredits(pricing, estUnits, 0);

  const baseUsage: Omit<UsageInput, "status" | "costMilli" | "paidCredits" | "vendorKeyId" | "unitCount"> = {
    requestId,
    userId: user.id,
    channel,
    apiKeyId, // 站外 Key（user_api_key.id）；站内为 null
    modelId: route.model.id,
    endpointType: modelKind,
    modelSnapshot: body.model,
    promptTokens: 0,
    outputTokens: 0,
  };

  // 余额类拒绝 402（含 <200 分禁生图/生视频门槛）；g19：Key 额度只读预检
  const pre = await billing.preCheck(user.id, estCredits, modelKind, 0, apiKeyId);
  if (!pre.ok) {
    return pre.code === "key_quota_exceeded"
      ? fail(402, pre.error || "API key quota exceeded", "insufficient_quota", "key_quota_exceeded")
      : fail(402, pre.error || "Insufficient credits", "insufficient_quota", "insufficient_credits");
  }

  // g19：图片不再预扣，成功后按实际消费结算（settle 内累加 Key 已用额度）

  // ── 6. 并发槽（超限退回预扣并 429；出口路径必须 release） ──
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

  let urls: string[] | null = null;
  let used: KeyCandidate | null = null;
  let lastError = "";
  // 客户端断连语义（与视频 worker 统一）：不中断生成。
  // 不监听 req.signal、不把 signal 传给 adapter —— 断连后服务器照常跑完，
  // 照常结算并把产物转存进「我的资产」；上游已发生的成本不会因为我们放弃而退回。
  for (const cand of attempts) {
    // U2：真正调用前才占用半开探测名额；名额已被占用则跳过该 Key
    if (!tryAcquireKeyCall(cand.vendorKeyId)) continue;
    markKeyUsed(cand.vendorKeyId);
    let r: Awaited<ReturnType<typeof callMediaGenerations>>;
    try {
      r = await callMediaGenerations({
        endpointType: modelKind,
        apiBase: cand.apiBase,
        apiKey: cand.apiKey,
        body: body as Record<string, unknown>,
      });
    } catch (e) {
      releaseKeyProbe(cand.vendorKeyId); // 异常退出也要归还探测名额
      throw e;
    }
    // P2 渠道健康：记录每次尝试结果
    const okOut = r.ok && r.urls.length > 0;
    recordKeyOutcome(cand.vendorKeyId, okOut, okOut ? 200 : r.status || 502);
    if (okOut) {
      urls = r.urls;
      used = cand;
      break;
    }
    lastError = r.errorMessage || `HTTP ${r.status}`;
  }

  // 全部 Key 失败：全额退回 + 502（只有真实上游失败会走到这里）
  if (!urls || !used) {
    slot.release();
    await billing.refund(user.id, requestId);
    await recordUsage({
      ...baseUsage,
      vendorKeyId: null,
      status: "failed",
      costMilli: 0,
      paidCredits: 0,
      latencyMs: Date.now() - started,
    });
    return fail(502, `Upstream generation service error: ${lastError}`, "api_error", "upstream_error");
  }

  // ── 8. 结算：按实际产物数量 ceil 整数积分（生成已发生，转存失败不退扣分） ──
  const units = unitsFor(pricing, urls.length, body.duration ?? 5);
  const costM = costMilli(units, pricing, "input");
  const paid = displayMemberCredits(pricing, units, 0);
  await billing.settle(user.id, requestId, paid, apiKeyId);
  const usageRecordId = await recordUsage({
    ...baseUsage,
    vendorKeyId: used.vendorKeyId,
    unitCount: units,
    costMilli: costM,
    paidCredits: paid,
    latencyMs: Date.now() - started,
    status: "success",
    // P3 价格版本快照（调价不回写历史）
    ...pricingSnapshot(pricing),
  });

  // ── 9. 生成成功即转存默认存储桶（30 天生命周期），返回我们自己的 URL ──
  const assetType: AssetType = modelKind === "video" ? "video" : "image";
  const data: Record<string, unknown>[] = [];
  for (const url of urls) {
    const saved = await saveGeneratedAsset({
      userId: user.id,
      usageRecordId,
      assetType,
      resultUrl: url,
    });
    const item: Record<string, unknown> = {
      // 我们自己的访问地址（签名 URL，私有读）
      url: saved.assetId != null ? `${SITE_BASE}/api/member/assets/${saved.assetId}/download` : null,
      asset_id: saved.assetId != null ? String(saved.assetId) : null,
      transfer_status: saved.ok ? "stored" : "retry_available",
    };
    if (!saved.ok) {
      // 转存失败：资产标 deleted，可经 assets API 重试拉取一次；source_url 供当次兜底
      item.source_url = url;
    }
    data.push(item);
  }
  slot.release();

  const responseBody = {
    created: Math.floor(Date.now() / 1000),
    data,
  };
  // 只缓存成功响应（含产物已转存后的资产地址），供同 Key 重试直接回放
  if (keyed) await saveIdempotentResponse(requestId, 200, responseBody);
  return NextResponse.json(responseBody, { headers: { "Cache-Control": "no-store" } });
}
