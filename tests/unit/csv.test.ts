import { describe, expect, it } from "vitest";
import { buildCsv, csvCell, csvTime } from "@/lib/csv";

describe("b6 用量导出 CSV", () => {
  it("带 BOM、CRLF 换行，Excel 打开不乱码", () => {
    const out = buildCsv(["时间", "积分"], [["2026-11-19 10:00", 3]]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out).toContain("\r\n");
    expect(out.endsWith("\r\n")).toBe(true);
  });

  it("逗号 / 引号 / 换行按 RFC4180 转义", () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("x\ny")).toBe('"x\ny"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(0)).toBe("0");
  });

  it("时间输出到分钟、UTC ISO 转空格分隔", () => {
    expect(csvTime("2026-11-19T02:03:04.000Z")).toBe("2026-11-19 02:03");
    expect(csvTime(null)).toBe("");
  });
});
