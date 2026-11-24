// ─── pa33 实验场运行看板：今日（Asia/Shanghai）onsite 调用聚合 ───
// 只做只读统计：不新增表 / 列，不改计费口径；数据源 usage_record（channel = onsite）。

export const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
export const DAY_MS = 24 * 3600 * 1000;

export interface PlaygroundStatsModel {
  model: string;
  calls: number;
  successCalls: number;
  successRate: number;
}

export interface PlaygroundStatsSummary {
  calls: number;
  successCalls: number;
  successRate: number;
  avgLatencyMs: number | null;
  topModels: PlaygroundStatsModel[];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// 返回「今日」的 Asia/Shanghai 自然日区间（左闭右开）与 YYYY-MM-DD
// 服务器时区不参与计算：先平移到 UTC+8 取日期，再平移回去得到 UTC 时间点。
export function shanghaiDayRange(now: Date = new Date()): { start: Date; end: Date; day: string } {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  const start = new Date(Date.UTC(y, m - 1, d) - SHANGHAI_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS), day: `${y}-${pad2(m)}-${pad2(d)}` };
}

// 聚合结果归一：成功率保留 4 位小数，平均耗时空值置 null（无样本），热门模型按调用量降序。
export function summarizePlaygroundStats(input: {
  calls: number;
  successCalls: number;
  avgLatencyMs: number | null;
  models: { model: string | null; calls: number; success: number }[];
  maxModels?: number;
}): PlaygroundStatsSummary {
  const calls = Math.max(0, input.calls || 0);
  const successCalls = Math.max(0, Math.min(calls, input.successCalls || 0));
  const topModels = input.models
    .filter((m) => (m.calls || 0) > 0)
    .map((m) => {
      const mc = Math.max(0, m.calls || 0);
      const ms = Math.max(0, Math.min(mc, m.success || 0));
      return {
        model: m.model || "未知模型",
        calls: mc,
        successCalls: ms,
        successRate: mc > 0 ? Number((ms / mc).toFixed(4)) : 0,
      };
    })
    .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model))
    .slice(0, input.maxModels ?? 5);

  const avg = input.avgLatencyMs;
  return {
    calls,
    successCalls,
    successRate: calls > 0 ? Number((successCalls / calls).toFixed(4)) : 0,
    avgLatencyMs: avg === null || avg === undefined || Number.isNaN(Number(avg)) ? null : Math.round(Number(avg)),
    topModels,
  };
}
