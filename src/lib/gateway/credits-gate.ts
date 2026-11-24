// ─── 积分准入门槛（按模型系列分级） ───
//
// 用途：某些上游模型要求账户预存/余额达到一定量才能调用，前端只是体验，
// 真正的准入判定放在 billing.preCheck（服务端拦截，返回 402 + min_balance_required）。
//
// 优先级：
//   1. ai_model.advancedConfig 里的 minBalanceCredits（数字，0 = 显式关闭）
//   2. 模型名系列默认值（doubao-seedance-2-5-* = 10000、doubao-seedance-2-0-* = 5000）
//   3. 0（不限制）
//
// 为什么用模型名兜底而不是数据库标记：线上模型不写库也能立刻生效；
// 将来出新系列（如 3.0）时，后台给该模型 advancedConfig 填 minBalanceCredits 即可，
// 无需改代码发版——字段优先于名称规则。

export interface MinBalanceModelLike {
  name: string;
  advancedConfig?: string | null;
}

// 系列默认门槛（积分）。注意顺序：更具体的系列放前面。
const SERIES_MIN_BALANCE: ReadonlyArray<{ test: RegExp; credits: number }> = [
  { test: /^doubao-seedance-2-5-/, credits: 10_000 },
  { test: /^doubao-seedance-2-0-/, credits: 5_000 },
];

export const DEFAULT_MIN_BALANCE_CREDITS = 0;

function parseAdvancedConfig(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// 该模型要求的最低账户积分余额（0 表示不限）
export function minBalanceCreditsFor(model: MinBalanceModelLike | null | undefined): number {
  if (!model) return DEFAULT_MIN_BALANCE_CREDITS;

  const cfg = parseAdvancedConfig(model.advancedConfig);
  const declared = cfg?.minBalanceCredits;
  if (typeof declared === "number" && Number.isFinite(declared)) {
    return Math.max(0, Math.trunc(declared));
  }

  for (const series of SERIES_MIN_BALANCE) {
    if (series.test.test(model.name)) return series.credits;
  }
  return DEFAULT_MIN_BALANCE_CREDITS;
}
