import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { sanitizeApiDocsHtml } from "@/lib/sanitize.server";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import {
  DEFAULT_API_DOCS_HTML,
  DEFAULT_API_DOCS_BASE_URL,
  API_DOCS_HTML_SETTING_KEY,
  API_DOCS_BASE_URL_SETTING_KEY,
} from "@/lib/api-docs-default";
import {
  GATEWAY_ROUTES_SETTING_KEY,
  getGatewayRoutes,
  normalizeRouteName,
  normalizeRouteUrl,
  type GatewayRoute,
} from "@/lib/gateway/gateway-routes";

export const dynamic = "force-dynamic";

// ─── 后台 · API 接口文档配置（v0.92 多线路 Base URL） ───
// SiteSetting：api_docs_html（文档正文 HTML）、api_docs_base_url（主线路 URL 同步副本）、
// api_gateway_routes（多线路 JSON [{name,url}]，每条线路域名即 /v1 网关白名单域名）。
// 空值 = 使用内置默认（文档/Base URL 用内置值）。
// 正文里的 {{BASE_URL}} / {{MODEL_TABLE}} 占位符由 ApiDocsContent 渲染时替换，保存时不处理。

// 读取当前生效值（含默认回退）
async function getEffective() {
  const rows = await db.siteSetting.findMany({
    where: { key: { in: [API_DOCS_HTML_SETTING_KEY, GATEWAY_ROUTES_SETTING_KEY] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const routes = await getGatewayRoutes();
  return {
    baseUrl: routes[0]?.url || DEFAULT_API_DOCS_BASE_URL,
    html: (map[API_DOCS_HTML_SETTING_KEY] || "").trim() || DEFAULT_API_DOCS_HTML,
    routes,
  };
}

// GET /api/admin/settings/api-docs → { baseUrl, html, routes }
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  return NextResponse.json(await getEffective());
}

const apiDocsSchema = z.object({
  baseUrl: z.string().max(500).optional(),
  html: z.string().max(500000).optional(),
  routes: z
    .array(z.object({ name: z.string().max(50).optional().default(""), url: z.string().max(500) }))
    .max(20)
    .optional(),
  reset: z.boolean().optional(),
});

// PUT /api/admin/settings/api-docs
// body { routes?, baseUrl?, html?, reset? }：html 保存前消毒；线路 URL 归一化（域名补 https:// 与 /v1）；
// reset:true 删除配置（恢复默认）
export async function PUT(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = apiDocsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { baseUrl, html, routes, reset } = parsed.data;

  if (reset) {
    // 恢复默认：删除配置（含旧「网关域名」），渲染时回退内置默认
    await db.siteSetting.deleteMany({
      where: {
        key: {
          in: [
            API_DOCS_HTML_SETTING_KEY,
            API_DOCS_BASE_URL_SETTING_KEY,
            GATEWAY_ROUTES_SETTING_KEY,
            "api_gateway_domains",
          ],
        },
      },
    });
    await logAdminAction({
      adminId: admin.id,
      action: "reset",
      targetType: "setting",
      detail: JSON.stringify({ section: "api-docs" }),
      ip: await getClientIp(),
    });
    return NextResponse.json({ ok: true, ...(await getEffective()) });
  }

  const touched: string[] = [];
  if (baseUrl !== undefined) {
    await db.siteSetting.upsert({
      where: { key: API_DOCS_BASE_URL_SETTING_KEY },
      update: { value: baseUrl.trim() },
      create: { key: API_DOCS_BASE_URL_SETTING_KEY, value: baseUrl.trim() },
    });
    touched.push(API_DOCS_BASE_URL_SETTING_KEY);
  }
  if (routes !== undefined) {
    // 归一化线路（名称截断、URL 补 https:// 与 /v1）后 JSON 落库；首线路同步到 api_docs_base_url
    const normalized: GatewayRoute[] = routes
      .map((r) => ({ name: normalizeRouteName(r.name || ""), url: normalizeRouteUrl(r.url || "") }))
      .filter((r) => !!r.url);
    const routesJson = JSON.stringify(normalized);
    await db.siteSetting.upsert({
      where: { key: GATEWAY_ROUTES_SETTING_KEY },
      update: { value: routesJson },
      create: { key: GATEWAY_ROUTES_SETTING_KEY, value: routesJson },
    });
    await db.siteSetting.upsert({
      where: { key: API_DOCS_BASE_URL_SETTING_KEY },
      update: { value: normalized[0]?.url || DEFAULT_API_DOCS_BASE_URL },
      create: { key: API_DOCS_BASE_URL_SETTING_KEY, value: normalized[0]?.url || DEFAULT_API_DOCS_BASE_URL },
    });
    // 清理旧「API 网关域名」配置（已并入多线路）
    await db.siteSetting.deleteMany({ where: { key: "api_gateway_domains" } });
    touched.push(GATEWAY_ROUTES_SETTING_KEY);
  }
  if (html !== undefined) {
    // 富文本净化后落库（白名单见 sanitizeApiDocsHtml；占位符是纯文本不受影响）
    const safe = sanitizeApiDocsHtml(html);
    await db.siteSetting.upsert({
      where: { key: API_DOCS_HTML_SETTING_KEY },
      update: { value: safe },
      create: { key: API_DOCS_HTML_SETTING_KEY, value: safe },
    });
    touched.push(API_DOCS_HTML_SETTING_KEY);
  }

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "setting",
    detail: JSON.stringify({ section: "api-docs", keys: touched }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, ...(await getEffective()) });
}
