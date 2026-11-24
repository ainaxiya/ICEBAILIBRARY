import { describe, expect, it } from "vitest";
import { DEFAULT_ENABLED, normalizeEnabled } from "@/lib/playground/settings";

describe("pa1 实验场总开关", () => {
  it("未配置时默认开启", () => {
    expect(DEFAULT_ENABLED).toBe(true);
    expect(normalizeEnabled(undefined)).toBe(true);
    expect(normalizeEnabled(null)).toBe(true);
    expect(normalizeEnabled("false")).toBe(true);
    expect(normalizeEnabled(0)).toBe(true);
  });

  it("只有显式 false 才关闭", () => {
    expect(normalizeEnabled(false)).toBe(false);
    expect(normalizeEnabled(true)).toBe(true);
  });
});
