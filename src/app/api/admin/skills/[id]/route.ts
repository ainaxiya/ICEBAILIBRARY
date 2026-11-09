import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { syncSkillToMeili, removeSkillFromMeili } from "@/lib/meili";

export const dynamic = "force-dynamic";

// 单条详情（编辑表单回填）
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { ok } = await requirePerm("skill:manage");
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const skill = await db.skill.findUnique({
    where: { id: Number(id) },
    include: { category: { select: { id: true, name: true, slug: true } } },
  });
  if (!skill) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(skill);
}

const fileEntry = z.object({
  path: z.string().min(1).max(300),
  // 整包上传的文件树清单只有 path/size（content 空）；__bundle__ 哨兵的 content 是桶内对象 key
  content: z.string().max(200_000).default(""),
  size: z.number().int().min(0).optional(),
});

const patchSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/).optional().or(z.literal("")),
  name: z.string().min(2).max(200).optional(),
  summary: z.string().min(1).max(2000).optional(),
  skillMd: z.string().min(1).max(200_000).optional(),
  files: z.array(fileEntry).max(2500).optional(),
  categoryId: z.number().int().positive().optional(),
  tags: z.array(z.string().max(30)).max(8).optional(),
  author: z.string().max(100).nullable().optional(),
  sourceUrl: z.string().max(500).nullable().optional().or(z.literal("")),
  sourceSite: z.string().max(100).nullable().optional(),
  version: z.string().max(50).nullable().optional(),
  license: z.string().max(50).nullable().optional(),
  language: z.string().max(10).optional(),
  status: z.enum(["published", "pending", "rejected"]).optional(),
  featured: z.boolean().optional(),
  viewCount: z.number().int().min(0).max(100_000_000).optional(),
  copyCount: z.number().int().min(0).max(100_000_000).optional(),
  downloadCount: z.number().int().min(0).max(100_000_000).optional(),
  commentCount: z.number().int().min(0).max(10_000_000).optional(),
  publishedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

// 更新
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { admin, ok } = await requirePerm("skill:manage");
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const skill = await db.skill.findUnique({ where: { id: Number(id) }, include: { category: true } });
  if (!skill) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const d = parsed.data;

  // slug 允许重复，不做查重
  if (d.categoryId) {
    const cat = await db.skillCategory.findUnique({ where: { id: d.categoryId } });
    if (!cat) return NextResponse.json({ error: "分类不存在" }, { status: 400 });
  }

  const data: any = {};
  if (d.slug !== undefined && d.slug) data.slug = d.slug;
  if (d.name !== undefined) data.name = d.name;
  if (d.summary !== undefined) data.summary = d.summary;
  if (d.skillMd !== undefined) data.skillMd = d.skillMd;
  if (d.files !== undefined) data.files = d.files.map((f) => ({ path: f.path, content: f.content, size: f.size ?? f.content.length }));
  if (d.categoryId !== undefined) data.categoryId = d.categoryId;
  if (d.tags !== undefined) data.tags = d.tags;
  if (d.author !== undefined) data.author = d.author || null;
  if (d.sourceUrl !== undefined) data.sourceUrl = d.sourceUrl?.trim() || null;
  if (d.sourceSite !== undefined) data.sourceSite = d.sourceSite || null;
  if (d.version !== undefined) data.version = d.version || null;
  if (d.license !== undefined) data.license = d.license || null;
  if (d.language !== undefined) data.language = d.language;
  if (d.status !== undefined) data.status = d.status;
  if (d.featured !== undefined) data.featured = d.featured;
  if (d.viewCount !== undefined) data.viewCount = d.viewCount;
  if (d.copyCount !== undefined) data.copyCount = d.copyCount;
  if (d.downloadCount !== undefined) data.downloadCount = d.downloadCount;
  if (d.commentCount !== undefined) data.commentCount = d.commentCount;
  if (d.publishedAt !== undefined) data.publishedAt = d.publishedAt ? new Date(d.publishedAt) : null;
  // 首次发布补 publishedAt
  if (d.status === "published" && !skill.publishedAt && d.publishedAt === undefined) data.publishedAt = new Date();

  const updated = await db.skill.update({
    where: { id: skill.id },
    data,
    include: { category: { select: { slug: true } } },
  });

  try {
    if (updated.status === "published") {
      await syncSkillToMeili({ ...updated, categorySlug: updated.category.slug });
    } else {
      await removeSkillFromMeili(skill.id);
    }
  } catch (e) {
    console.warn("[meili] skill update index failed:", skill.id, e);
  }

  await logAdminAction({
    adminId: admin.id, action: "update", targetType: "skill", targetId: skill.id,
    detail: `更新技能「${updated.name}」`, ip: await getClientIp(),
  });
  return NextResponse.json({ ok: true });
}

// 删除（孤儿评论保留，由后台评论管理手动清理）
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { admin, ok } = await requirePerm("skill:manage");
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const skill = await db.skill.findUnique({ where: { id: Number(id) } });
  if (!skill) return NextResponse.json({ error: "not found" }, { status: 404 });

  await db.skill.delete({ where: { id: skill.id } });
  try {
    await removeSkillFromMeili(skill.id);
  } catch (e) {
    console.warn("[meili] skill delete index failed:", skill.id, e);
  }

  await logAdminAction({
    adminId: admin.id, action: "delete", targetType: "skill", targetId: skill.id,
    detail: `删除技能「${skill.name}」`, ip: await getClientIp(),
  });
  return NextResponse.json({ ok: true });
}
