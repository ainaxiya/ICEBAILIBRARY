import { NextRequest } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { requireAdmin } from "@/lib/auth";
import { ADMIN_BASE } from "@/lib/admin-path";

// ─── 搜索管理（Meiliadmin v1.4.0 集成）· SPA 托管 ───
// 挂在 /meiliadmin/app/ 子路径下，由后台 /meiliadmin 页面以 iframe 内嵌（左侧菜单保持固定）
// - index.html 注入 APP.meilisearch 配置（走同源 /meiliadmin/proxy/ 代理，key 不下发）→ 跳过登录页
// - /meiliadmin/app/assets/*  静态资源
// 真正的 API 代理在 ../proxy/[...path]/route.ts

export const dynamic = "force-dynamic";

const DIST = path.join(process.cwd(), "meiliadmin-dist");
const BASE = `${ADMIN_BASE}/meiliadmin`;
const APP_BASE = `${BASE}/app`;
const API_PREFIX = "/proxy/";

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function secureHeaders(contentType: string) {
  return {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=86400",
  };
}

// 注入运行配置：rootURL 挂到 /meiliadmin/app/ 子路径 + APP.meilisearch 预认证（去登录页）
function injectConfig(html: string) {
  let out = html.replace(
    /(<meta name="meiliadmin\/config\/environment" content=")([^"]*)(")/,
    (_m, p1: string, enc: string, p3: string) => {
      const cfg = JSON.parse(decodeURIComponent(enc));
      cfg.rootURL = `${APP_BASE}/`;
      // 子路径部署用 hash 路由：刷新/直链稳定，避免 history 模式路径前缀重复
      cfg.locationType = "hash";
      cfg.APP = { ...(cfg.APP || {}), meilisearch: { url: "", key: "" } };
      return p1 + encodeURIComponent(JSON.stringify(cfg)) + p3;
    }
  );
  // 静态资源绝对路径挂到子路径下（/assets/ → .../meiliadmin/app/assets/）
  out = out.replace(/="\/assets\//g, `="${APP_BASE}/assets/`);
  // <base> 供 webpack 相对 chunk 解析（必须在 <link>/<script> 之前）
  out = out.replace("<head>", `<head><base href="${APP_BASE}/">`);
  // 启动前用 location.origin 填充代理地址（反代后服务端只知道内部 origin）；
  // 必须插在 meta 标签之后、body 内 Ember 启动脚本之前
  const patch =
    `<script>(function(){var m=document.querySelector('meta[name="meiliadmin/config/environment"]');` +
    `if(!m)return;var c=JSON.parse(decodeURIComponent(m.getAttribute("content")));` +
    `c.APP.meilisearch.url=location.origin+"${BASE}${API_PREFIX}";` +
    `m.setAttribute("content",encodeURIComponent(JSON.stringify(c)));})();</script>`;
  out = out.replace("</head>", patch + "</head>");
  // 本地化 favicon（顺带消除 404）
  if (!/<link rel="icon"/.test(out)) {
    out = out.replace("</head>", '<link rel="icon" href="/logo/icon.png"></head>');
  }
  return out;
}

async function serveStatic(rel: string[]) {
  // 防目录穿越：仅允许普通文件名段
  if (rel.some((s) => !/^[A-Za-z0-9._-]+$/.test(s))) {
    return new Response("Bad Request", { status: 400 });
  }
  const file = path.join(DIST, ...rel);
  if (!file.startsWith(DIST)) return new Response("Bad Request", { status: 400 });
  try {
    const buf = await readFile(file);
    const mime = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    return new Response(new Uint8Array(buf), { headers: secureHeaders(mime) });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

async function handler(req: NextRequest, segs: string[]) {
  // 静态资源（css/js/字体等）无敏感数据，公开提供——iframe 内加载失败会白屏转圈，
  // 且不应受登录态/第三方 cookie 影响
  if (segs[0] === "assets") {
    return serveStatic(segs);
  }

  const admin = await requireAdmin();
  if (!admin) {
    // 相对 Location：反代后 req.url 是内部地址（localhost:3000），不能作为重定向基址
    return new Response(null, {
      status: 302,
      headers: { Location: `${ADMIN_BASE}/login?next=${encodeURIComponent(APP_BASE + "/")}` },
    });
  }

  // SPA 入口 / Ember 路由回退
  try {
    const html = await readFile(path.join(DIST, "index.html"), "utf8");
    return new Response(injectConfig(html), {
      headers: { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
    });
  } catch {
    return new Response("Meiliadmin dist missing", { status: 500 });
  }
}

type Ctx = { params: Promise<{ path?: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return handler(req, (await ctx.params).path || []);
}
