import type { ModelPricing } from "@prisma/client";

// ─── P3 模型库：Prisma Decimal/BigInt → JSON 安全值 ───
// BigInt 无法 JSON.stringify，Decimal 需转 number；统一在此归一

export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return Number(String(v));
}

// ModelPricing 行 → API/前端安全结构
export function pricingJson(p: ModelPricing) {
  return {
    id: p.id,
    modelId: p.modelId,
    meterBase: p.meterBase,
    unit: p.unit,
    inputPrice: num(p.inputPrice),
    outputPrice: num(p.outputPrice),
    currency: p.currency,
    fxRateE8: num(p.fxRateE8),
    multiplierBps: p.multiplierBps,
    effectiveAt: p.effectiveAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
  };
}

export type PricingJson = ReturnType<typeof pricingJson>;

// 明文 Key → 存储前缀（识别用，如 sk-abc***）；密文/明文永不回显
export function keyPrefixOf(plain: string): string {
  const head = plain.slice(0, 8);
  return plain.length > 8 ? `${head}***` : head;
}
