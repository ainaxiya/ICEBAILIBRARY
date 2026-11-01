import type { ModelPricing } from "@prisma/client";

// ─── P1 聚合网关：成本换算与标价（方案 5.3） ───
// 成本（毫积分） = 计量值 × 单价(供应商币种) × fxRateE8/1e8 × 100积分/元 × 1000毫/积分 ÷ meterBase
// 对用户标价 = ceil(成本 × 加价系数)（每次使用再 ceil 一次，最低 1 分）
// cost_milli 仅内部毛利报表，不进用户余额

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

// 标价：ceil(成本 × 加价系数) 整数积分，最低 1 分
export function displayCredits(
  costMilliValue: number,
  multiplierBps: number | bigint
): number {
  const mult = toNum(multiplierBps) / 10000;
  return Math.max(1, Math.ceil((costMilliValue * mult) / 1000));
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

// 预检估值：按预估 token 数算 ceil 标价（供 billing.preCheck 对余额门槛）
export function estimateCredits(
  model: { pricings?: readonly ModelPricing[] } | null,
  estTokens: { input: number; output: number }
): number {
  const pricing = latestPricing(model);
  if (!pricing) return 1;
  return displayCredits(
    totalCostMilli(pricing, estTokens.input, estTokens.output),
    pricing.multiplierBps
  );
}
