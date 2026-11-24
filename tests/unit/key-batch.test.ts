import { describe, expect, it } from "vitest";
import {
  applyTagOp,
  isProbeSuccess,
  normalizeTags,
  planKeyRepairs,
  TAG_MAX_COUNT,
  TAG_MAX_LEN,
} from "@/lib/admin/key-batch";

describe("normalizeTags", () => {
  it("接受数组并去空白/去重", () => {
    expect(normalizeTags([" 生产 ", "生产", "测试", ""])).toEqual(["生产", "测试"]);
  });

  it("接受中英文逗号、顿号、换行分隔的字符串", () => {
    expect(normalizeTags("生产,测试，备用、高并发\n海外")).toEqual(["生产", "测试", "备用", "高并发", "海外"]);
  });

  it("过滤非字符串项", () => {
    expect(normalizeTags([123, null, "生产"] as unknown)).toEqual(["生产"]);
  });

  it("截断超长标签并限制总数", () => {
    const long = "x".repeat(TAG_MAX_LEN + 5);
    expect(normalizeTags([long])[0]).toHaveLength(TAG_MAX_LEN);
    const many = Array.from({ length: TAG_MAX_COUNT + 5 }, (_, i) => `t${i}`);
    expect(normalizeTags(many)).toHaveLength(TAG_MAX_COUNT);
  });
});

describe("applyTagOp", () => {
  it("add 合并去重，保留原顺序", () => {
    expect(applyTagOp(["生产", "高并发"], "add", ["高并发", "海外"])).toEqual(["生产", "高并发", "海外"]);
  });

  it("remove 只删指定标签", () => {
    expect(applyTagOp(["生产", "测试", "海外"], "remove", "测试")).toEqual(["生产", "海外"]);
  });

  it("replace 整体覆盖", () => {
    expect(applyTagOp(["生产", "测试"], "replace", "海外,备用")).toEqual(["海外", "备用"]);
  });
});

describe("planKeyRepairs", () => {
  const now = new Date("2026-11-19T00:00:00Z").getTime();

  it("非法状态 → disabled", () => {
    const fixes = planKeyRepairs([{ id: 1, status: "paused", weight: 1, maintainUntil: null }], now);
    expect(fixes).toEqual([{ id: 1, field: "status", from: "paused", to: "disabled" }]);
  });

  it("权重 < 1 → 1", () => {
    const fixes = planKeyRepairs([{ id: 2, status: "active", weight: 0, maintainUntil: null }], now);
    expect(fixes).toEqual([{ id: 2, field: "weight", from: 0, to: 1 }]);
  });

  it("过期维护窗口 → 清空", () => {
    const fixes = planKeyRepairs(
      [{ id: 3, status: "active", weight: 1, maintainUntil: new Date(now - 1000) }],
      now
    );
    expect(fixes).toEqual([
      { id: 3, field: "maintainUntil", from: new Date(now - 1000).toISOString(), to: null },
    ]);
  });

  it("健康数据不做修复；未过期的维护窗口保留", () => {
    const fixes = planKeyRepairs(
      [{ id: 4, status: "disabled", weight: 3, maintainUntil: new Date(now + 60_000) }],
      now
    );
    expect(fixes).toEqual([]);
  });
});

describe("isProbeSuccess", () => {
  it("2xx/3xx 视为可用", () => {
    expect(isProbeSuccess(200)).toBe(true);
    expect(isProbeSuccess(302)).toBe(true);
  });

  it("4xx/5xx 与网络失败视为不可用", () => {
    expect(isProbeSuccess(401)).toBe(false);
    expect(isProbeSuccess(503)).toBe(false);
    expect(isProbeSuccess(0)).toBe(false);
  });
});
