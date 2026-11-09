import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { ModelPricing } from "@prisma/client";
import { saveGeneratedAsset, type AssetType } from "@/lib/assets";
import { authenticateV1 } from "@/lib/gateway/auth";
import { billing } from "@/lib/gateway/billing";
import { resolveRequestId } from "@/lib/gateway/idempotency";
import { callMediaGenerations } from "@/lib/gateway/adapters/media";
import { costMilli, displayMemberCredits } from "@/lib/gateway/pricing";
import { markKeyUsed, resolveRoute, type KeyCandidate } from "@/lib/gateway/router";
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

// OpenAI 风格错误体
function apiError(status: number, message: string, type: string, code: string) {
  return NextResponse.json({ error: { message, type, code } }, { status });
}

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
    return apiError(400, "Invalid request body: " + parsed.error.issues[0]?.message, "invalid_request_error", "invalid_body");
  }
  const body = parsed.data;

  // ── 3. 配额（apikey 通道只做 Key 层 RPM；onsite 通道会员层日次数/RPM） ──
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

  // ── 4. 预检：模型 / 端点 / 定价（endpointType 分发 image|video） ──
  const route = await resolveRoute(body.model);
  if (!route) {
    return apiError(404, "Model not found or offline", "invalid_request_error", "model_not_found");
  }
  const modelKind = route.model.endpointType;
  if (modelKind !== "image" && modelKind !== "video") {
    return apiError(404, "This model does not support generation endpoints", "invalid_request_error", "endpoint_disabled");
  }
  const endpointPath = modelKind === "video" ? "video_generations" : "image_generations";
  const endpoint = route.endpoints.find((e) => e.path === endpointPath && e.enabled);
  if (!endpoint) {
    return apiError(404, `This model does not support the ${endpointPath} endpoint`, "invalid_request_error", "endpoint_disabled");
  }
  const pricing = route.pricing;
  if (!pricing) {
    return apiError(404, "Model pricing is not configured", "invalid_request_error", "pricing_not_configured");
  }

  // S0-4：客户端 Idempotency-Key → 计费幂等 requestId（重试不重复扣费）
  const requestId = resolveRequestId(user.id, req);
  const started = Date.now();
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

  // 余额类拒绝 402（含 <200 分禁生图/生视频门槛）
  const pre = await billing.preCheck(user.id, estCredits, modelKind);
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

  let urls: string[] | null = null;
  let used: KeyCandidate | null = null;
  let lastError = "";
  for (const cand of attempts) {
    markKeyUsed(cand.vendorKeyId);
    const r = await callMediaGenerations({
      endpointType: modelKind,
      apiBase: cand.apiBase,
      apiKey: cand.apiKey,
      body: body as Record<string, unknown>,
    });
    if (r.ok && r.urls.length > 0) {
      urls = r.urls;
      used = cand;
      break;
    }
    lastError = r.errorMessage || `HTTP ${r.status}`;
  }

  // 全部 Key 失败：全额退回 + 502
  if (!urls || !used) {
    slot.release();
    await billing.refund(user.id, requestId);
    await recordUsage({ ...baseUsage, vendorKeyId: null, status: "failed", costMilli: 0, paidCredits: 0, latencyMs: Date.now() - started });
    return apiError(502, `Upstream generation service error: ${lastError}`, "api_error", "upstream_error");
  }

  // ── 8. 结算：按实际产物数量 ceil 整数积分（生成已发生，转存失败不退扣分） ──
  const units = unitsFor(pricing, urls.length, body.duration ?? 5);
  const costM = costMilli(units, pricing, "input");
  const paid = displayMemberCredits(pricing, units, 0);
  await billing.settle(user.id, requestId, paid);
  const usageRecordId = await recordUsage({
    ...baseUsage,
    vendorKeyId: used.vendorKeyId,
    unitCount: units,
    costMilli: costM,
    paidCredits: paid,
    latencyMs: Date.now() - started,
    status: "success",
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

  return NextResponse.json({
    created: Math.floor(Date.now() / 1000),
    data,
  });
}
