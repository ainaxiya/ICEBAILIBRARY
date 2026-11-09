import { NextRequest, NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site-config";

// ─── v0.92：API 网关域名隔离 ───
// 后台「多线路 Base URL」配置的域名即 API 网关域名：
//   /v1/*     → 正常进应用（gateway/auth 再做白名单 + Key 鉴权）
//   其他路径  → 一律返回 JSON 文档指引（不再渲染站内首页/页面）
// 站内主域名（www 等）不受影响。域名列表经 /api/gateway-meta 读取（30s 缓存）。

let hostsCache: { hosts: string[]; at: number } | null = null;
const CACHE_MS = 30_000;

async function gatewayHosts(): Promise<string[]> {
  if (hostsCache && Date.now() - hostsCache.at < CACHE_MS) return hostsCache.hosts;
  try {
    const port = process.env.PORT || "3000";
    const r = await fetch(`http://127.0.0.1:${port}/api/gateway-meta`, { cache: "no-store" });
    const d = (await r.json()) as { hosts?: string[] };
    hostsCache = { hosts: (d.hosts || []).map((h) => h.toLowerCase()), at: Date.now() };
    return hostsCache.hosts;
  } catch {
    // 取不到域名列表时放行（应用层白名单仍兜底），避免误伤站内页面
    return hostsCache?.hosts || [];
  }
}

function normalizeHost(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (path.startsWith("/v1")) return NextResponse.next();
  if (path === "/api/gateway-meta") return NextResponse.next();

  const host = normalizeHost(req.headers.get("x-forwarded-host") || req.headers.get("host") || "");
  if (!host) return NextResponse.next();

  const hosts = await gatewayHosts();
  if (!hosts.includes(host)) return NextResponse.next();

  // API 网关域名的非 /v1 路径：返回文档指引 JSON
  const site = SITE_URL;
  return NextResponse.json(
    {
      message: `The API documentation for this site can be found at the following URL: \`${site}/api-docs\``,
    },
    { status: 200 }
  );
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|robots.txt|sitemap.xml|sitemap-.*.xml).*)"],
};
