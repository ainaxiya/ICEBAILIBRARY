import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONA,
  PERSONA_MAX_LEN,
  normalizePersona,
} from "@/lib/playground/settings";

describe("pa8 平台级人设提示词", () => {
  it("默认空字符串，不额外注入系统提示", () => {
    expect(DEFAULT_PERSONA).toBe("");
    expect(normalizePersona(null)).toBe("");
    expect(normalizePersona(undefined)).toBe("");
    expect(normalizePersona("")).toBe("");
    expect(normalizePersona("   \n\t ")).toBe("");
  });

  it("去掉首尾空白并保留正文", () => {
    expect(normalizePersona("  你是冰山 AI 助手。\n")).toBe("你是冰山 AI 助手。");
  });

  it("超长内容按上限截断", () => {
    const long = "角".repeat(PERSONA_MAX_LEN + 100);
    expect(normalizePersona(long).length).toBe(PERSONA_MAX_LEN);
  });

  it("非字符串输入回落为空（不抛错）", () => {
    expect(normalizePersona(123)).toBe("");
    expect(normalizePersona({ text: "x" })).toBe("");
  });
});
