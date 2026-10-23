import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { syncSkillToMeili } from "@/lib/meili";
import { detectLang } from "@/lib/langdetect";
import { getSystemUser } from "@/lib/system-user";

export const dynamic = "force-dynamic";

// GET /api/admin/skills?page=&q=&status=&categoryId=
export async function GET(req: NextRequest) {
  const { ok } = await requirePerm("skill:manage");
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
  const q = (searchParams.get("q") || "").trim();
  const status = searchParams.get("status") || "";
  const categoryId = parseInt(searchParams.get("categoryId") || "") || 0;
  const pageSize = 30;

  const where: any = {};
  if (["published", "pending", "rejected"].includes(status)) where.status = status;
  if (categoryId) where.categoryId = categoryId;
  if (q) where.OR = [{ name: { contains: q, mode: "insensitive" } }, { summary: { contains: q, mode: "insensitive" } }];

  const [list, total, counts] = await Promise.all([
    db.skill.findMany({
      where,
      orderBy: [{ id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { category: { select: { id: true, name: true, slug: true } } },
    }),
    db.skill.count({ where }),
    db.skill.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  return NextResponse.json({
    list, total, page, pageSize,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
  });
}

const fileEntry = z.object({
  path: z.string().min(1).max(300),
  content: z.string().max(200_000),
  size: z.number().int().min(0).optional(),
});

const upsertSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/, "slug 必须为小写字母/数字/连字符").optional().or(z.literal("")),
  name: z.string().min(2).max(200),
  summary: z.string().min(1).max(2000),
  skillMd: z.string().min(1).max(200_000),
  files: z.array(fileEntry).max(20).optional(),
  categoryId: z.number().int().positive(),
  tags: z.array(z.string().max(30)).max(8).optional(),
  author: z.string().max(100).nullable().optional(),
  sourceUrl: z.string().max(500).nullable().optional().or(z.literal("")),
  sourceSite: z.string().max(100).nullable().optional(),
  version: z.string().max(50).nullable().optional(),
  license: z.string().max(50).nullable().optional(),
  language: z.string().max(10).optional(),
  status: z.enum(["published", "pending", "rejected"]).optional(),
  viewCount: z.number().int().min(0).max(100_000_000).optional(),
  copyCount: z.number().int().min(0).max(100_000_000).optional(),
  downloadCount: z.number().int().min(0).max(100_000_000).optional(),
  commentCount: z.number().int().min(0).max(10_000_000).optional(),
  publishedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

// slug 自动生成：取 name 的拉丁字符，兜底 skill-<时间戳>
function autoSlug(name: string) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s.length >= 2 ? s : `skill-${Date.now().toString(36)}`;
}

// POST 新建（仅后台可添加）
export async function POST(req: NextRequest) {
  const { admin, ok } = await requirePerm("skill:manage");
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = upsertSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const d = parsed.data;

  const cat = await db.skillCategory.findUnique({ where: { id: d.categoryId } });
  if (!cat) return NextResponse.json({ error: "分类不存在" }, { status: 400 });

  const slug = d.slug?.trim() || autoSlug(d.name);
  // slug 允许重复（URL 形式为 slug-id，按 id 精确定位）

  const status = d.status || "published";
  const systemUser = await getSystemUser();
  const files = (d.files || []).map((f) => ({ path: f.path, content: f.content, size: f.size ?? f.content.length }));

  const skill = await db.skill.create({
    data: {
      slug,
      name: d.name,
      summary: d.summary,
      skillMd: d.skillMd,
      files,
      categoryId: cat.id,
      tags: d.tags || [],
      author: d.author || null,
      sourceUrl: d.sourceUrl?.trim() || null,
      sourceSite: d.sourceSite || null,
      version: d.version || null,
      license: d.license || null,
      language: d.language || detectLang(d.name + "\n" + d.summary),
      status,
      viewCount: d.viewCount || 0,
      copyCount: d.copyCount || 0,
      downloadCount: d.downloadCount || 0,
      commentCount: d.commentCount || 0,
      userId: systemUser.id,
      publishedAt: d.publishedAt ? new Date(d.publishedAt) : status === "published" ? new Date() : null,
    },
  });

  if (status === "published") {
    try {
      await syncSkillToMeili({ ...skill, categorySlug: cat.slug });
    } catch (e) {
      console.warn("[meili] skill create index failed:", skill.id, e);
    }
  }

  await logAdminAction({
    adminId: admin.id, action: "create", targetType: "skill", targetId: skill.id,
    detail: `新建技能「${d.name}」`, ip: await getClientIp(),
  });
  return NextResponse.json({ id: skill.id, slug: skill.slug, status });
}
