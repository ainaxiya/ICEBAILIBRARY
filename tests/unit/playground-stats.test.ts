import { describe, expect, it } from "vitest";
import { shanghaiDayRange, summarizePlaygroundStats } from "@/lib/playground/stats";

describe("pa33 实验场运行看板", () => {
  it("今日区间按北京时间自然日切分（UTC 16:00 起算）", () => {
    // 北京时间 2026-11-22 00:30 = UTC 2026-11-21 16:30
    const r = shanghaiDayRange(new Date("2026-11-21T16:30:00.000Z"));
    expect(r.day).toBe("2026-11-22");
    expect(r.start.toISOString()).toBe("2026-11-21T16:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-11-22T16:00:00.000Z");

    // 北京时间 2026-11-22 23:59:59 仍属同一天
    const late = shanghaiDayRange(new Date("2026-11-22T15:59:59.999Z"));
    expect(late.day).toBe("2026-11-22");
    expect(late.start.toISOString()).toBe(r.start.toISOString());
  });

  it("跨月与跨年边界按 UTC+8 计算", () => {
    expect(shanghaiDayRange(new Date("2026-12-31T16:00:00.000Z")).day).toBe("2027-01-01");
    expect(shanghaiDayRange(new Date("2026-01-31T16:00:00.000Z")).day).toBe("2026-02-01");
  });

  it("汇总成功率与平均耗时", () => {
    const s = summarizePlaygroundStats({
      calls: 10,
      successCalls: 8,
      avgLatencyMs: 1234.6,
      models: [
        { model: "gpt-image-2", calls: 5, success: 4 },
        { model: "doubao-seedance-2-5", calls: 5, success: 4 },
      ],
    });
    expect(s.successRate).toBe(0.8);
    expect(s.avgLatencyMs).toBe(1235);
    expect(s.topModels).toHaveLength(2);
    expect(s.topModels[0].successRate).toBe(0.8);
  });

  it("无样本时成功率为 0、平均耗时为 null", () => {
    const s = summarizePlaygroundStats({ calls: 0, successCalls: 0, avgLatencyMs: null, models: [] });
    expect(s.successRate).toBe(0);
    expect(s.avgLatencyMs).toBeNull();
    expect(s.topModels).toEqual([]);
  });

  it("热门模型按调用量降序，最多 5 条，空模型名回落为未知模型", () => {
    const s = summarizePlaygroundStats({
      calls: 21,
      successCalls: 20,
      avgLatencyMs: 300,
      models: [
        { model: "a", calls: 2, success: 2 },
        { model: "b", calls: 9, success: 8 },
        { model: null, calls: 4, success: 4 },
        { model: "c", calls: 1, success: 1 },
        { model: "d", calls: 3, success: 3 },
        { model: "e", calls: 2, success: 1 },
      ],
      maxModels: 5,
    });
    expect(s.topModels.map((m) => m.model)).toEqual(["b", "未知模型", "d", "a", "e"]);
  });
});
