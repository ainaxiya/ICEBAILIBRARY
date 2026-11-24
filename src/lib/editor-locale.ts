"use client";

// 编辑器界面语言：按系统语言自动识别，无手动开关；未收录的语言回退英文。
import { localeActions } from "reactjs-tiptap-editor/locale";
import zhCN from "reactjs-tiptap-editor/locales/zh-cn";
import ja from "reactjs-tiptap-editor/locales/ja";
import vi from "reactjs-tiptap-editor/locales/vi";
import ptBR from "reactjs-tiptap-editor/locales/pt-br";
import hu from "reactjs-tiptap-editor/locales/hu";
import fi from "reactjs-tiptap-editor/locales/fi";

let initialized = false;

/** 浏览器语言 → 编辑器语言码；未收录回退英文（导出供测试） */
export function mapEditorLang(raw: string): string {
  const lang = String(raw || "").toLowerCase();
  if (lang.startsWith("zh")) return "zh_CN";
  if (lang.startsWith("ja")) return "ja";
  if (lang.startsWith("vi")) return "vi";
  if (lang.startsWith("pt")) return "pt_BR";
  if (lang.startsWith("hu")) return "hu_HU";
  if (lang.startsWith("fi")) return "fi";
  return "en";
}

function detectLang(): string {
  return mapEditorLang(navigator.languages?.[0] || navigator.language || "en");
}

export function initEditorLocale() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  localeActions.setMessage("zh_CN", zhCN);
  localeActions.setMessage("ja", ja);
  localeActions.setMessage("vi", vi);
  localeActions.setMessage("pt_BR", ptBR);
  localeActions.setMessage("hu_HU", hu);
  localeActions.setMessage("fi", fi);
  localeActions.setLang(detectLang());
}
