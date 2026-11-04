import { db } from "@/lib/db";
import ApiDocsTocNav from "@/components/ApiDocsTocNav";
import { sanitizeApiDocsHtml } from "@/lib/sanitize.server";
import {
  DEFAULT_API_DOCS_HTML,
  DEFAULT_API_DOCS_BASE_URL,
  API_DOCS_HTML_SETTING_KEY,
  API_DOCS_BASE_URL_SETTING_KEY,
  BASE_URL_PLACEHOLDER,
  MODEL_TABLE_PLACEHOLDER,
} from "@/lib/api-docs-default";

// ─── 站外 API 接口帮助文档 · 文档主体（目录 + 正文 + 动态模型目录表） ───
// 左右分栏：左侧粘性锚点目录（ApiDocsTocNav，IntersectionObserver 高亮），右侧文档正文。
// 文档正文存 SiteSetting.api_docs_html（空 = 内置默认 DEFAULT_API_DOCS_HTML，见 src/lib/api-docs-default.ts），
// Base URL 存 SiteSetting.api_docs_base_url（空 = DEFAULT_API_DOCS_BASE_URL），后台「API 文档」页可编辑与恢复默认。
// 正文 HTML 中的 {{BASE_URL}} / {{MODEL_TABLE}} 占位符在服务端渲染时替换；
// 模型目录表为实时查库（ai_model status=online + 最新 ModelPricing.unit）。
// 前台 /api-docs 与后台「API 文档」页共用本组件，文档内容保持单一真源。

const UNIT_LABEL: Record<string, string> = {
  token: "token（按百万 token 计价）",
  image: "image（按张计价）",
  video_second: "video_second（按秒 × 条数计价）",
  request: "request（按次计价）",
};

function esc(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 动态模型目录表 HTML（样式走 globals.css 的 .api-docs-prose 规则）
// 按厂商分组：每个厂商一个 h3 小节 + 一张表（模型名/展示名/类型/计价单位），
// 避免上百个模型挤在一张巨型表里。（h3 不进目录，目录只取 h2。）
function buildModelTableHtml(
  models: {
    name: string;
    displayName: string;
    endpointType: string;
    vendorName: string;
    unit: string | null;
  }[]
) {
  if (!models.length) {
    return `<div class="tbl"><table class="models">
<thead><tr><th>模型名（model 参数）</th><th>展示名</th><th>类型</th><th>计价单位</th></tr></thead>
<tbody>
<tr><td colspan="4">暂无在线模型，请稍后再试或联系我们。</td></tr>
</tbody>
</table></div>`;
  }

  // 按厂商分组（保持传入顺序：厂商名 → 模型名）
  const groups = new Map<string, typeof models>();
  for (const m of models) {
    const list = groups.get(m.vendorName);
    if (list) list.push(m);
    else groups.set(m.vendorName, [m]);
  }

  const parts: string[] = [];
  for (const [vendorName, list] of groups) {
    const rowsHtml = list
      .map(
        (m) => `<tr>
<td>${esc(m.name)}</td>
<td>${esc(m.displayName)}</td>
<td>${esc(m.endpointType)}</td>
<td>${esc(m.unit ? UNIT_LABEL[m.unit] || m.unit : "未配置")}</td>
</tr>`
      )
      .join("\n");
    parts.push(`<h3>${esc(vendorName)}（${list.length} 个模型）</h3>
<div class="tbl"><table class="models">
<thead><tr><th>模型名（model 参数）</th><th>展示名</th><th>类型</th><th>计价单位</th></tr></thead>
<tbody>
${rowsHtml}
</tbody>
</table></div>`);
  }
  return parts.join("\n");
}

// 从最终 HTML 提取 h2 目录（文本 + id，缺 id 自动补 sec-N 并写回正文，保证锚点可跳）
function extractToc(html: string): { html: string; toc: { id: string; title: string }[] } {
  const toc: { id: string; title: string }[] = [];
  const used = new Set<string>();
  let n = 0;
  const out = html.replace(
    /<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi,
    (whole: string, attrs: string, inner: string) => {
      n++;
      const idMatch = /\bid="([^"]*)"/i.exec(attrs);
      let id = idMatch?.[1]?.trim() || "";
      if (!id || used.has(id)) id = `sec-${n}`;
      used.add(id);
      const title =
        inner
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, " ")
          .trim() || `第 ${n} 节`;
      toc.push({ id, title });
      return idMatch && idMatch[1].trim() === id ? whole : `<h2 id="${id}"${attrs}>${inner}</h2>`;
    }
  );
  return { html: out, toc };
}

export default async function ApiDocsContent() {
  // 文档配置 + 动态模型目录：status=online 的模型 + 最新一行定价的计价单位
  const [settingRows, modelRows] = await Promise.all([
    db.siteSetting.findMany({
      where: { key: { in: [API_DOCS_HTML_SETTING_KEY, API_DOCS_BASE_URL_SETTING_KEY] } },
    }),
    db.aiModel.findMany({
      where: { status: "online" },
      include: {
        vendor: true,
        pricings: { orderBy: { effectiveAt: "desc" }, take: 1 },
      },
      orderBy: [{ vendor: { name: "asc" } }, { name: "asc" }],
    }),
  ]);

  const settings = Object.fromEntries(settingRows.map((r) => [r.key, r.value]));
  const rawHtml = (settings[API_DOCS_HTML_SETTING_KEY] || "").trim() || DEFAULT_API_DOCS_HTML;
  const baseUrl =
    (settings[API_DOCS_BASE_URL_SETTING_KEY] || "").trim() || DEFAULT_API_DOCS_BASE_URL;

  const models = modelRows.map((m) => ({
    name: m.name,
    displayName: m.displayName,
    endpointType: m.endpointType,
    vendorName: m.vendor.name,
    unit: m.pricings[0]?.unit ?? null,
  }));

  // 净化 → 占位符替换 → h2 锚点补齐/目录提取
  const sanitized = sanitizeApiDocsHtml(rawHtml);
  const withVars = sanitized
    .split(BASE_URL_PLACEHOLDER)
    .join(esc(baseUrl))
    .split(MODEL_TABLE_PLACEHOLDER)
    .join(buildModelTableHtml(models));
  const { html, toc } = extractToc(withVars);

  return (
    <div className="flex gap-10">
      {/* ── 左侧：粘性锚点目录（窄屏隐藏，正文前另有折叠目录） ── */}
      <aside className="hidden w-56 shrink-0 lg:block">
        <nav className="sticky top-24">
          <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            本页目录
          </p>
          <ApiDocsTocNav items={toc} />
        </nav>
      </aside>

      {/* ── 右侧：文档正文（HTML 内容存库，可后台编辑） ── */}
      <div className="min-w-0 flex-1">
        {/* 窄屏：折叠到顶部的目录 */}
        <details className="mb-8 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3 lg:hidden">
          <summary className="cursor-pointer text-sm font-medium text-zinc-200">本页目录</summary>
          <div className="mt-3">
            <ApiDocsTocNav items={toc} />
          </div>
        </details>

        <article className="api-docs-prose" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
