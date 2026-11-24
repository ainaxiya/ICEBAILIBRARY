// b18 运营看板指标计算（纯函数，便于单测；SQL 聚合在组件内完成）
// 口径：余额真源 = credit_grant 有效剩余；消耗 = usage_record.paidCredits；
// 预计可用天数 = 全站有效余额 ÷ 近 7 天日均消耗（无消耗时返回 null，不做估算）。

export type BalanceBucketKey = "zero" | "low" | "mid" | "high" | "vip";

export const BALANCE_BUCKETS: { key: BalanceBucketKey; label: string }[] = [
  { key: "zero", label: "0 积分" },
  { key: "low", label: "1 – 1,000" },
  { key: "mid", label: "1,001 – 10,000" },
  { key: "high", label: "10,001 – 100,000" },
  { key: "vip", label: "100,000 以上" },
];

export function percent(part: number, total: number): number {
  if (!(total > 0) || !(part > 0)) return 0;
  return Math.round((part / total) * 1000) / 10;
}

export function balanceHealth(
  counts: Record<BalanceBucketKey, number>
): { key: BalanceBucketKey; label: string; count: number; percent: number }[] {
  const total = BALANCE_BUCKETS.reduce((s, b) => s + (counts[b.key] || 0), 0);
  return BALANCE_BUCKETS.map((b) => {
    const count = counts[b.key] || 0;
    return { key: b.key, label: b.label, count, percent: percent(count, total) };
  });
}

export function estimateSupportDays(totalBalance: number, consumption7d: number): number | null {
  if (!Number.isFinite(totalBalance) || totalBalance < 0) return null;
  if (!Number.isFinite(consumption7d) || consumption7d <= 0) return null;
  return Math.round((totalBalance / (consumption7d / 7)) * 10) / 10;
}

export function modelShare(
  rows: { name: string | null; credits: number | bigint; calls: number | bigint }[],
  limit = 8
): { name: string; credits: number; calls: number; percent: number }[] {
  const total = rows.reduce((s, r) => s + Number(r.credits || 0), 0);
  return rows.slice(0, limit).map((r) => {
    const credits = Number(r.credits || 0);
    return {
      name: r.name || "未知模型",
      credits,
      calls: Number(r.calls || 0),
      percent: percent(credits, total),
    };
  });
}

// 近 N 天按 UTC 日桶补齐（与消费报表同口径），缺失日期补 0
export function fillDailyGrowth(
  rows: { d: string; n: number | bigint }[],
  days = 14,
  now = new Date()
): { date: string; label: string; count: number }[] {
  const map = new Map(rows.map((r) => [r.d, Number(r.n || 0)]));
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: { date: string; label: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(end - i * 86400_000).toISOString().slice(0, 10);
    out.push({ date, label: date.slice(5), count: map.get(date) || 0 });
  }
  return out;
}
