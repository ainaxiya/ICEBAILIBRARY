import "server-only";
import sanitizeHtml from "sanitize-html";
// 富文本清洗实现已抽到 sanitize-rich（客户端编辑器同样复用），这里保持原导出路径不变。
export { sanitizeRich } from "./sanitize-rich";

// API 接口文档正文清洗：语义标签 + 表格 + h2/h3 的 id（TOC 锚点）与 class
// 与 sanitizeRich 的差异：放行 table/thead/tbody/tfoot/tr/th/td/caption，且允许 id 属性。
export function sanitizeApiDocsHtml(input: string): string {
  if (!input) return "";
  return sanitizeHtml(input, {
    allowedTags: [
      "p", "br", "b", "strong", "i", "em", "u", "s", "h1", "h2", "h3", "h4",
      "ul", "ol", "li", "blockquote", "hr", "a", "img", "video", "source",
      "div", "span", "pre", "code", "details", "summary",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
    ],
    allowedAttributes: {
      "*": ["id", "class"],
      a: ["href", "target", "rel"],
      img: ["src", "alt", "class"],
      video: ["src", "controls", "poster", "class"],
      source: ["src", "type"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "data"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
  }).trim();
}
