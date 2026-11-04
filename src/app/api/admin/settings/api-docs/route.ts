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

export const dynamic = "force-dynamic";

// ─── 后台 · API 接口文档配置 ───
// SiteSetting 两个 key：api_docs_html（文档正文 HTML）、api_docs_base_url（示例 Base URL）。
// 空值 = 使用内置默认（DEFAULT_API_DOCS_HTML / DEFAULT_API_DOCS_BASE_URL）。
// 正文里的 {{BASE_URL}} / {{MODEL_TABLE}} 占位符由 ApiDocsContent 渲染时替换，保存时不处理。

// 读取当前生效值（含默认回退）
async function getEffective() {
  const rows = await db.siteSetting.findMany({
    where: { key: { in: [API_DOCS_HTML_SETTING_KEY, API_DOCS_BASE_URL_SETTING_KEY] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    baseUrl: (map[API_DOCS_BASE_URL_SETTING_KEY] || "").trim() || DEFAULT_API_DOCS_BASE_URL,
    html: (map[API_DOCS_HTML_SETTING_KEY] || "").trim() || DEFAULT_API_DOCS_HTML,
  };
}

// GET /api/admin/settings/api-docs → { baseUrl, html }
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
  reset: z.boolean().optional(),
});

// PUT /api/admin/settings/api-docs
// body { baseUrl?, html?, reset? }：html 保存前消毒；reset:true 删除两个 key（恢复默认）
export async function PUT(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = apiDocsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { baseUrl, html, reset } = parsed.data;

  if (reset) {
    // 恢复默认：删除两个 key，渲染时回退内置默认
    await db.siteSetting.deleteMany({
      where: { key: { in: [API_DOCS_HTML_SETTING_KEY, API_DOCS_BASE_URL_SETTING_KEY] } },
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
