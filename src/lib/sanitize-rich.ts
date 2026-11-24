// 富文本白名单清洗（服务端/客户端共用）
// - 白名单须与 RichEditor（reactjs-tiptap-editor）实际产出的标签/属性保持一致
// - 服务端在 API 写入/详情渲染时做最终校验；客户端在粘贴与 onChange 输出时同样走这里
// 说明：sanitize-html 只依赖 htmlparser2 等纯 JS 包，可同时运行在 Node 与浏览器。

import sanitizeHtml from "sanitize-html";
import { isHtmlContent } from "./rich";

// 允许的标签（与编辑器能力对齐：标题/列表/引用/表格/代码块/高亮/图片/视频）
export const RICH_ALLOWED_TAGS = [
  "p", "br", "b", "strong", "i", "em", "u", "s", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "hr", "a", "img", "video", "source",
  "iframe", "div", "span", "pre", "code", "mark",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
];

// 允许的属性（mark 的 background-color 单独限制取值，见 allowedStyles）
export const RICH_ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "target", "rel", "class"],
  img: ["src", "alt", "class", "width", "height", "title"],
  video: ["src", "controls", "poster", "class", "width", "height", "preload", "playsinline"],
  source: ["src", "type"],
  iframe: ["src", "class", "allowfullscreen", "frameborder", "allow"],
  span: ["class", "style"],
  mark: ["class", "data-color", "style"],
  div: ["class"],
  p: ["class"],
  pre: ["class", "data-language"],
  code: ["class"],
  table: ["class"],
  td: ["colspan", "rowspan", "class"],
  th: ["colspan", "rowspan", "class"],
};

// 仅允许 mark 背景色、span 字体/字号/颜色样式，防 style 注入
export const RICH_ALLOWED_STYLES: Record<string, Record<string, RegExp[]>> = {
  mark: {
    "background-color": [/^#[0-9a-fA-F]{3,8}$/, /^rgba?\([\d\s.,%]+\)$/, /^[a-zA-Z]+$/],
  },
  span: {
    color: [/^#[0-9a-fA-F]{3,8}$/, /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/, /^[a-zA-Z]{3,20}$/],
    "background-color": [/^#[0-9a-fA-F]{3,8}$/, /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/, /^[a-zA-Z]{3,20}$/],
    "font-size": [/^\d{1,2}(\.\d+)?(px|em|rem|%|pt)$/],
    "font-family": [/^[-a-zA-Z0-9\s,"'\u4e00-\u9fa5]{1,120}$/],
  },
};

export const RICH_IFRAME_HOSTS = [
  "www.youtube.com",
  "youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "player.bilibili.com",
];

// 富文本白名单清洗：仅编辑器产出的安全标签；iframe 限定 YouTube/Bilibili
export function sanitizeRich(input: string): string {
  if (!input) return "";
  // 历史纯文本原样保留（详情页走旧的 [N] 分段渲染）
  if (!isHtmlContent(input)) return input.trim();

  return sanitizeHtml(input, {
    allowedTags: RICH_ALLOWED_TAGS,
    allowedAttributes: RICH_ALLOWED_ATTRIBUTES,
    allowedStyles: RICH_ALLOWED_STYLES,
    allowedSchemes: ["http", "https", "data"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowedIframeHostnames: RICH_IFRAME_HOSTS,
    // src 被域名白名单剥离后，整个 iframe 一并移除（避免留下空 iframe）
    exclusiveFilter: (frame) => frame.tag === "iframe" && !frame.attribs.src,
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener nofollow" }),
    },
  }).trim();
}
