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
  const sorted = [...list].sort(
    (a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime()
  );
  return sorted.find((p) => p.effectiveAt.getTime() <= now) ?? sorted[0];
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
