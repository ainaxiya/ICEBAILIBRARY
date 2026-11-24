import { describe, it, expect } from "vitest";
import {
  BALANCE_BUCKETS,
  balanceHealth,
  estimateSupportDays,
  fillDailyGrowth,
  modelShare,
  percent,
} from "@/lib/ops-metrics";

// ─── b18 运营看板指标口径 ───
// 校验：余额分桶百分比、无消耗不估算、模型占比按全量分母、增长日桶补零

describe("ops-metrics 运营看板指标", () => {
  it("percent 处理零分母与越界输入", () => {
    expect(percent(0, 0)).toBe(0);
    expect(percent(5, 0)).toBe(0);
    expect(percent(0, 10)).toBe(0);
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(2, 3)).toBe(66.7);
  });

  it("balanceHealth 按固定分桶输出人数与百分比", () => {
    const rows = balanceHealth({ zero: 3, low: 2, mid: 1, high: 0, vip: 0 });
    expect(rows).toHaveLength(BALANCE_BUCKETS.length);
    expect(rows.map((r) => r.key)).toEqual(["zero", "low", "mid", "high", "vip"]);
    expect(rows.map((r) => r.count)).toEqual([3, 2, 1, 0, 0]);
    expect(rows[0].percent).toBe(50);
    expect(rows[1].percent).toBe(33.3);
    expect(rows.reduce((s, r) => s + r.count, 0)).toBe(6);
  });

  it("estimateSupportDays 无消耗返回 null，有消耗按 7 天日均折算", () => {
    expect(estimateSupportDays(10000, 0)).toBeNull();
    expect(estimateSupportDays(10000, -1)).toBeNull();
    expect(estimateSupportDays(-1, 100)).toBeNull();
    expect(estimateSupportDays(700, 700)).toBe(7);
    expect(estimateSupportDays(7000, 700)).toBe(70);
    expect(estimateSupportDays(1000, 300)).toBe(23.3);
  });

  it("modelShare 按全量分母计算占比并截断到 top N", () => {
    const rows = modelShare(
      [
        { name: "gpt-4o", credits: 100n, calls: 10 },
        { name: "claude", credits: 50, calls: 5 },
        { name: null, credits: 50n, calls: 2 },
      ],
      2
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "gpt-4o", credits: 100, calls: 10, percent: 50 });
    expect(rows[1]).toMatchObject({ name: "claude", credits: 50, calls: 5, percent: 25 });
    const withUnknown = modelShare([{ name: null, credits: 10, calls: 1 }]);
    expect(withUnknown[0].name).toBe("未知模型");
  });

  it("fillDailyGrowth 按 UTC 日补齐缺失日期，顺序由旧到新", () => {
    const now = new Date("2026-11-19T10:00:00.000Z");
    const out = fillDailyGrowth(
      [
        { d: "2026-11-17", n: 2 },
        { d: "2026-11-19", n: 5n },
      ],
      3,
      now
    );
    expect(out.map((r) => r.date)).toEqual(["2026-11-17", "2026-11-18", "2026-11-19"]);
    expect(out.map((r) => r.count)).toEqual([2, 0, 5]);
    expect(out.map((r) => r.label)).toEqual(["11-17", "11-18", "11-19"]);
  });
});
