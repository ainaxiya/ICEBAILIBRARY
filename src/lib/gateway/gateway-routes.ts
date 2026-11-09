import { db } from "@/lib/db";
import { API_DOCS_BASE_URL_SETTING_KEY, DEFAULT_API_DOCS_BASE_URL } from "@/lib/api-docs-default";

// ─── 网关多线路 Base URL（v0.92） ───
// SiteSetting.api_gateway_routes = JSON [{name,url}...]（名称 + 域名/URL，一行一线路）。
// 每条线路的域名同时是 /v1 网关白名单域名（多线路=多 API 域名）。
// 兼容：无线路配置时回退旧单值 api_docs_base_url，再回退内置默认（配置 API_GATEWAY_BASE_URL）。
// 保存线路时会同步第一线路 URL 到 api_docs_base_url（API 文档 {{BASE_URL}} 取它）。

export interface GatewayRoute {
  name: string;
  url: string;
}

export const GATEWAY_ROUTES_SETTING_KEY = "api_gateway_routes";

// 归一化线路 URL：补 https://、去尾斜杠；裸域名补 /v1（文档示例即 Base URL）
export function normalizeRouteUrl(raw: string): string {
  let u = (raw || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  u = u.replace(/\/+$/, "");
  const path = u.replace(/^https?:\/\/[^/]*/i, "");
  if (!path) u += "/v1";
  return u;
}

export function normalizeRouteName(raw: string): string {
  return (raw || "").trim().slice(0, 50);
}

export function parseGatewayRoutes(raw: string | null | undefined): GatewayRoute[] {
  if (!raw || !raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((r: { name?: string; url?: string }) => ({
        name: normalizeRouteName(r?.name || ""),
        url: normalizeRouteUrl(r?.url || ""),
      }))
      .filter((r) => !!r.url);
  } catch {
    return [];
  }
}

// 线路域名列表（小写）= /v1 白名单
export function hostnamesOfRoutes(routes: GatewayRoute[]): string[] {
  return [
    ...new Set(
      routes
        .map((r) => {
          try {
            return new URL(r.url).hostname.toLowerCase();
          } catch {
            return "";
          }
        })
        .filter(Boolean)
    ),
  ];
}

// 生效线路：api_gateway_routes → 旧单值 api_docs_base_url → 内置默认
export async function getGatewayRoutes(): Promise<GatewayRoute[]> {
  const rows = await db.siteSetting.findMany({
    where: { key: { in: [GATEWAY_ROUTES_SETTING_KEY, API_DOCS_BASE_URL_SETTING_KEY] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const routes = parseGatewayRoutes(map[GATEWAY_ROUTES_SETTING_KEY]);
  if (routes.length) return routes;
  const legacy = normalizeRouteUrl(map[API_DOCS_BASE_URL_SETTING_KEY] || "");
  return [{ name: "默认线路", url: legacy || DEFAULT_API_DOCS_BASE_URL }];
}
