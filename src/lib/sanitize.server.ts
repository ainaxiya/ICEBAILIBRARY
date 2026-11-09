import "server-only";
import sanitizeHtml from "sanitize-html";
import { isHtmlContent } from "./rich";

// 富文本白名单清洗：仅编辑器产出的安全标签；iframe 限定 YouTube/Bilibili
export function sanitizeRich(input: string): string {
  if (!input) return "";
  // 历史纯文本原样保留（详情页走旧的 [N] 分段渲染）
  if (!isHtmlContent(input)) return input.trim();

  return sanitizeHtml(input, {
    allowedTags: [
      "p", "br", "b", "strong", "i", "em", "u", "s", "h1", "h2", "h3", "h4", "h5", "h6",
      "ul", "ol", "li", "blockquote", "hr", "a", "img", "video", "source",
      "iframe", "div", "span", "pre", "code", "mark",
      "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
    ],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt", "class"],
      video: ["src", "controls", "poster", "class"],
      source: ["src", "type"],
      iframe: ["src", "class", "allowfullscreen", "frameborder", "allow"],
      span: ["class"],
      mark: ["class"],
      div: ["class"],
      p: ["class"],
      pre: ["class", "data-language"],
      code: ["class"],
      table: ["class"],
      td: ["colspan", "rowspan", "class"],
      th: ["colspan", "rowspan", "class"],
    },
    allowedSchemes: ["http", "https", "data"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowedIframeHostnames: [
      "www.youtube.com",
      "youtube.com",
      "youtube-nocookie.com",
      "www.youtube-nocookie.com",
      "player.bilibili.com",
    ],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener nofollow" }),
    },
  }).trim();
}

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
