import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { sanitizeRich } from "@/lib/sanitize.server";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { SITE_PAGE_SLUGS, SITE_PAGE_DEFAULT_TITLES, type SitePageSlug } from "@/lib/site-page";

export const dynamic = "force-dynamic";

// GET /api/admin/settings/pages
// 返回 5 个固定页列表（缺行时按默认中文标题 upsert 种子）
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const pages = [];
  for (const slug of SITE_PAGE_SLUGS) {
    const row = await db.sitePage.upsert({
      where: { slug },
      create: { slug, title: SITE_PAGE_DEFAULT_TITLES[slug], content: "" },
      update: {},
    });
    pages.push(row);
  }
  return NextResponse.json({ pages });
}

const pageSchema = z.object({
  slug: z.enum(SITE_PAGE_SLUGS),
  title: z.string().min(1).max(100),
  content: z.string().max(500000).default(""),
});

// PUT /api/admin/settings/pages
export async function PUT(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = pageSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { slug, title, content } = parsed.data;

  // 富文本净化后落库
  const safe = sanitizeRich(content);
  const row = await db.sitePage.upsert({
    where: { slug },
    create: { slug, title, content: safe },
    update: { title, content: safe },
  });

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "setting",
    detail: JSON.stringify({ section: "pages", slug }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, page: row });
}
