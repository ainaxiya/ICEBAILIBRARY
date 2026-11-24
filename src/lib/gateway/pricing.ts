import type { ModelPricing } from "@prisma/client";

// ─── P1 聚合网关：成本换算与标价（方案 5.3） ───
// 成本（毫积分） = 计量值 × 单价(供应商币种) × fxRateE8/1e8 × 100积分/元 × 1000毫/积分 ÷ meterBase
// 对用户标价 = ceil(成本 × 加价系数)（每次使用再 ceil 一次，最低 1 分）
// cost_milli 仅内部毛利报表，不进用户余额
// v0.92 #5 计费透明化：对外展示一律用「百万 tokens 成本价/会员价（积分）」，1 元 = 100 积分

// Prisma.Decimal / number / string / bigint → number
function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return Number(v);
  const d = v as { toNumber?: () => number };
  if (d && typeof d.toNumber === "function") return d.toNumber();
  return Number(v);
}

// 计价参数（结构上兼容 Prisma ModelPricing）
export interface PricingLike {
  meterBase: number | bigint;
  inputPrice: unknown;
  outputPrice: unknown;
  fxRateE8: bigint | number;
  multiplierBps: number | bigint;
  // v0.96 直观定价：会员价按输入/输出直接填（积分/计量基数）；为空回退「成本 × multiplierBps」
  memberInputPrice?: unknown;
  memberOutputPrice?: unknown;
}

// 单边成本（毫积分，取整）；side 决定取输入价还是输出价
export function costMilli(
  measure: number,
  pricing: PricingLike,
  side: "input" | "output" = "input"
): number {
  const price = toNum(side === "input" ? pricing.inputPrice : pricing.outputPrice);
  const fx = toNum(pricing.fxRateE8) / 1e8;
  const base = toNum(pricing.meterBase) || 1;
  return Math.round((measure * price * fx * 100 * 1000) / base);
}

// 一次调用总成本（输入 + 输出，毫积分）
export function totalCostMilli(
  pricing: PricingLike,
  promptTokens: number,
  outputTokens: number
): number {
  return (
    costMilli(promptTokens, pricing, "input") +
    costMilli(outputTokens, pricing, "output")
  );
}

// ─── v0.92 #5 计费透明化：百万 tokens 成本价/会员价（1 元 = 100 积分） ───

// 成本价（积分/百万 tokens，可带小数展示）：单价 × 汇率 × 100积分/元 × (100万 ÷ meterBase)
export function perMillionCostCredits(
  pricing: PricingLike,
  side: "input" | "output"
): number {
  const price = toNum(side === "input" ? pricing.inputPrice : pricing.outputPrice);
  const fx = toNum(pricing.fxRateE8) / 1e8;
  const base = toNum(pricing.meterBase) || 1;
  return (price * fx * 100 * 1_000_000) / base;
}

// 会员价（积分/百万 tokens，ceil 整数）：优先按直接填的会员价换算，否则成本价 × 加价系数
export function perMillionMemberCredits(
  pricing: PricingLike,
  side: "input" | "output"
): number {
  const member = toNum(side === "input" ? pricing.memberInputPrice : pricing.memberOutputPrice);
  if (Number.isFinite(member) && member > 0) {
    return Math.max(1, Math.ceil((member * 1_000_000) / (toNum(pricing.meterBase) || 1)));
  }
  const cost = perMillionCostCredits(pricing, side);
  return Math.max(1, Math.ceil(cost * (toNum(pricing.multiplierBps) / 10000)));
}

// ─── v0.113 媒体模型预览（按张/按秒/按次，meterBase=1）：每计量单位积分 ───
// 成本积分/单位 = 单价 × 汇率 × 100（1 元 = 100 积分）
export function perUnitCostCredits(
  pricing: PricingLike,
  side: "input" | "output"
): number {
  const price = toNum(side === "input" ? pricing.inputPrice : pricing.outputPrice);
  const fx = toNum(pricing.fxRateE8) / 1e8;
  return price * fx * 100;
}

// 会员积分/单位：优先直接填的会员价（积分/张|秒|次），否则成本积分 × 加价系数
export function perUnitMemberCredits(
  pricing: PricingLike,
  side: "input" | "output"
): number {
  const member = toNum(side === "input" ? pricing.memberInputPrice : pricing.memberOutputPrice);
  if (Number.isFinite(member) && member > 0) return Math.max(1, Math.ceil(member));
  return Math.max(1, Math.ceil(perUnitCostCredits(pricing, side) * (toNum(pricing.multiplierBps) / 10000)));
}

// 计价单位后缀（后台模型库列表/文档展示用）
export function pricingUnitSuffix(unit: string): string {
  if (unit === "image") return "积分/张";
  if (unit === "video_second" || unit === "audio_second") return "积分/秒";
  if (unit === "request") return "积分/次";
  if (unit === "char") return "积分/千字符";
  return "积分/M";
}

// ─── v0.96 会员价按输入/输出直接计费（毫积分）；未填会员价时回退成本 × 加价系数 ───

// 单边会员价（毫积分，取整）
export function memberSideMilli(
  measure: number,
  pricing: PricingLike,
  side: "input" | "output"
): number {
  const member = toNum(side === "input" ? pricing.memberInputPrice : pricing.memberOutputPrice);
  if (Number.isFinite(member) && member > 0) {
    return Math.round((measure * member * 1000) / (toNum(pricing.meterBase) || 1));
  }
  return Math.round((costMilli(measure, pricing, side) * toNum(pricing.multiplierBps)) / 10000);
}

// 一次调用会员价（输入 + 输出，毫积分）
export function memberCreditsMilli(
  pricing: PricingLike,
  promptTokens: number,
  outputTokens: number
): number {
  return (
    memberSideMilli(promptTokens, pricing, "input") +
    memberSideMilli(outputTokens, pricing, "output")
  );
}

// 一次调用会员标价（整数积分，ceil，最低 1 分）——替代 displayCredits(totalCostMilli(...), mult)
export function displayMemberCredits(
  pricing: PricingLike,
  promptTokens: number,
  outputTokens: number
): number {
  return Math.max(1, Math.ceil(memberCreditsMilli(pricing, promptTokens, outputTokens) / 1000));
}

// 取最新生效定价（effectiveAt 最大且 <= now；无生效的退回最近一条）
export function latestPricing(
  model: { pricings?: readonly ModelPricing[] } | null
): ModelPricing | null {
  const list = model?.pricings;
  if (!list || list.length === 0) return null;
  const now = Date.now();
  const pick = (arr: ModelPricing[]) => {
    const sorted = [...arr].sort(
      (a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime()
    );
    return sorted.find((p) => p.effectiveAt.getTime() <= now) ?? sorted[0];
  };
  // 通用行（variant=""）优先，避免把某个分辨率档位当成全模型默认价；
  // 若只有档位行（老模型没写通用价），仍回退到最新的那一行，保持兼容。
  const generic = list.filter((p) => ((p as { variant?: string | null }).variant ?? "") === "");
  return generic.length > 0 ? pick(generic) : pick([...list]);
}

// 按计费档位取价：精确匹配 variant（如 720p:v），没有则回退通用价
export function pricingForVariant(
  model: { pricings?: readonly ModelPricing[] } | null,
  variant: string
): ModelPricing | null {
  const list = model?.pricings;
  if (!list || list.length === 0) return null;
  const exact = list.filter(
    (p) => ((p as { variant?: string | null }).variant ?? "") === variant
  );
  if (exact.length === 0) return latestPricing(model);
  const now = Date.now();
  const sorted = [...exact].sort(
    (a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime()
  );
  return sorted.find((p) => p.effectiveAt.getTime() <= now) ?? sorted[0];
}

// ─── v1.0.94 视频统一秒价：只认通用行（variant=""），不再区分分辨率/含视频档位 ───
// 与 latestPricing 不同：没有通用行时返回 null，不会拿历史档位行当默认价。
export function genericPricing<T extends { effectiveAt: Date; variant?: string | null }>(
  model: { pricings?: readonly T[] } | null
): T | null {
  const list = model?.pricings;
  if (!list || list.length === 0) return null;
  const generic = list.filter((p) => ((p as { variant?: string | null }).variant ?? "") === "");
  if (generic.length === 0) return null;
  const now = Date.now();
  const sorted = [...generic].sort(
    (a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime()
  );
  return sorted.find((p) => p.effectiveAt.getTime() <= now) ?? sorted[0];
}

type VideoPricingLike = PricingLike & { unit?: string };

// 视频每秒成本积分（内部核算）：成本价未填 / 非视频秒单位 → null
export function videoPerSecondCostCredits(
  pricing: VideoPricingLike | null | undefined
): number | null {
  if (!pricing) return null;
  if (pricing.unit != null && pricing.unit !== "video_second") return null;
  const cost = perUnitCostCredits(pricing, "input");
  return Number.isFinite(cost) && cost > 0 ? cost : null;
}

// 视频每秒会员积分：会员价优先；未填会员价但有成本价时按倍率折算；
// 两套都留空 → null（未定价，不按最低 1 分兜底）。
export function videoPerSecondMemberCredits(
  pricing: VideoPricingLike | null | undefined
): number | null {
  if (!pricing) return null;
  if (pricing.unit != null && pricing.unit !== "video_second") return null;
  const member = toNum(pricing.memberInputPrice);
  if (Number.isFinite(member) && member > 0) return Math.max(1, Math.ceil(member));
  const cost = videoPerSecondCostCredits(pricing);
  if (cost == null) return null;
  return Math.max(1, Math.ceil(cost * (toNum(pricing.multiplierBps) / 10000)));
}

// 视频任务会员积分 = ceil(每秒会员价) × 秒数；未定价 → null
export function videoTaskMemberCredits(
  pricing: VideoPricingLike | null | undefined,
  seconds: number
): number | null {
  const perSecond = videoPerSecondMemberCredits(pricing);
  if (perSecond == null) return null;
  const sec = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (sec <= 0) return null;
  return Math.ceil(perSecond * sec);
}

// 从请求体推断计费档位键：分辨率 × 是否含视频输入
// ratio/宽高比不参与定价（官方只按分辨率档位给价，同档 9:16 与 16:9 像素数相同）
export function videoVariantFromBody(
  body: Record<string, unknown> | null | undefined
): string {
  const raw = typeof body?.resolution === "string" ? body.resolution.trim() : "";
  const res = raw ? raw.replace(/p$/i, "p") : "720p"; // Ark 缺省按 720p 计
  const norm = /^4k/i.test(res) ? "4K" : /^(480|720|1080)p$/i.test(res) ? res.toLowerCase() : "720p";
  const hasVideoInput =
    (Array.isArray(body?.reference_videos) && body.reference_videos.length > 0) ||
    typeof body?.reference_video === "string" ||
    typeof body?.video_url === "string";
  return `${norm}:${hasVideoInput ? "v" : "n"}`;
}

type VideoTierPricing = VideoPricingLike & { effectiveAt: Date; variant?: string | null };

function latestEffective<T extends { effectiveAt: Date }>(list: readonly T[]): T | null {
  if (list.length === 0) return null;
  const now = Date.now();
  const sorted = [...list].sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime());
  return sorted.find((p) => p.effectiveAt.getTime() <= now) ?? sorted[0];
}

// v1.0.98 视频档位价优先：精确档位（如 720p:n）→ 通用秒价 → 未定价。
// 档位行填 0/null 视为「该档位留空」，同样回退通用秒价；不会拿别的档位价顶替。
export function videoPricingForVariant<T extends VideoTierPricing>(
  model: { pricings?: readonly T[] } | null | undefined,
  variant: string
): T | null {
  const list = model?.pricings;
  if (!list || list.length === 0) return null;
  const exact = latestEffective(
    list.filter(
      (p) => ((p.variant ?? "") === variant) && (p.unit == null || p.unit === "video_second")
    )
  );
  if (exact && videoPerSecondMemberCredits(exact) != null) return exact;
  const generic = genericPricing(model);
  return generic && videoPerSecondMemberCredits(generic) != null ? generic : null;
}

// 前台展示 / 准入：默认 720p:n → 720p:v → 通用秒价 → 任意已定价档位（取最低，作为「起」价）
export function videoDisplayPricing<T extends VideoTierPricing>(
  model: { pricings?: readonly T[] } | null | undefined
): T | null {
  const preferred = videoPricingForVariant(model, "720p:n");
  if (preferred) return preferred;
  const list = model?.pricings;
  if (!list || list.length === 0) return null;
  const priced = list.filter(
    (p) => p.unit === "video_second" && videoPerSecondMemberCredits(p) != null
  );
  if (priced.length === 0) return null;
  return priced.reduce((a, b) =>
    (videoPerSecondMemberCredits(a) ?? Infinity) <= (videoPerSecondMemberCredits(b) ?? Infinity) ? a : b
  );
}

// ─── P3 价格版本快照：结算时点的单价定格（方案 9.2「调价不回写历史账单」） ───
// usage_record.price_snapshot 存 JSON，调价后可按快照重算任意历史请求的应扣金额。
export function pricingSnapshot(pricing: ModelPricing): {
  priceVersionId: number | null;
  priceSnapshot: string;
} {
  const snap = {
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
  return { priceVersionId: pricing.id, priceSnapshot: JSON.stringify(snap) };
}

// 预检估值：按预估 token 数算 ceil 会员标价（供 billing.preCheck 对余额门槛）
export function estimateCredits(
  model: { pricings?: readonly ModelPricing[] } | null,
  estTokens: { input: number; output: number }
): number {
  const pricing = latestPricing(model);
  if (!pricing) return 1;
  return displayMemberCredits(pricing, estTokens.input, estTokens.output);
}
