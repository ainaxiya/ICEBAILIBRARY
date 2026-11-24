import { describe, expect, it } from "vitest";
import { mapEditorLang } from "@/lib/editor-locale";

// e3/e11：多语言自动识别与回退
describe("mapEditorLang", () => {
  it("识别已收录语言（大小写与地区后缀不敏感）", () => {
    expect(mapEditorLang("zh-CN")).toBe("zh_CN");
    expect(mapEditorLang("zh-TW")).toBe("zh_CN");
    expect(mapEditorLang("ja-JP")).toBe("ja");
    expect(mapEditorLang("vi-VN")).toBe("vi");
    expect(mapEditorLang("pt-BR")).toBe("pt_BR");
    expect(mapEditorLang("hu-HU")).toBe("hu_HU");
    expect(mapEditorLang("fi-FI")).toBe("fi");
    expect(mapEditorLang("en-US")).toBe("en");
  });

  it("未收录语言与空值回退英文", () => {
    expect(mapEditorLang("fr-FR")).toBe("en");
    expect(mapEditorLang("de")).toBe("en");
    expect(mapEditorLang("")).toBe("en");
  });
});
