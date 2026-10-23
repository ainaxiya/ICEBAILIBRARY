import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { syncSoftwareToMeili, removeSoftwareFromMeili } from "@/lib/meili";
import { sanitizeRich } from "@/lib/sanitize.server";
import { isHtmlContent } from "@/lib/rich";
import { localizeIcon } from "@/lib/icon-localize.server";

export const dynamic = "force-dynamic";

// 单条详情（编辑表单回填，含下载条目）
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { ok } = await requirePerm("software:manage");
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const soft = await db.software.findUnique({
    where: { id: Number(id) },
    include: {
      category: { select: { id: true, name: true, slug: true } },
      downloads: { orderBy: [{ sort: "asc" }, { id: "asc" }] },
    },
  });
  if (!soft) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    ...soft,
    downloads: soft.downloads.map((d) => ({ ...d, sizeBytes: d.sizeBytes != null ? Number(d.sizeBytes) : null })),
  });
}

const downloadEntry = z.object({
  label: z.string().min(1).max(100),
  storageType: z.enum(["local", "bucket"]).default("local"),
  fileUrl: z.string().max(500).nullable().optional(),
  bucketId: z.number().int().positive().nullable().optional(),
  objectKey: z.string().max(500).nullable().optional(),
  sizeBytes: z.number().int().min(0).nullable().optional(),
  memberOnly: z.boolean().default(false),
  sort: z.number().int().min(0).max(999).default(0),
});

const patchSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/).optional().or(z.literal("")),
  name: z.string().min(1).max(200).optional(),
  version: z.string().max(50).nullable().optional(),
  tagline: z.string().max(300).nullable().optional(),
  description: z.string().min(1).max(200_000).optional(),
  icon: z.string().max(500).nullable().optional(),
  categoryId: z.number().int().positive().optional(),
  tags: z.array(z.string().max(30)).max(8).optional(),
  sizeText: z.string().max(50).nullable().optional(),
  platform: z.string().max(100).nullable().optional(),
  language: z.string().max(50).nullable().optional(),
  officialUrl: z.string().max(500).nullable().optional().or(z.literal("")),
  status: z.enum(["published", "pending", "rejected"]).optional(),
  viewCount: z.number().int().min(0).max(100_000_000).optional(),
  downloadCount: z.number().int().min(0).max(100_000_000).optional(),
  commentCount: z.number().int().min(0).max(10_000_000).optional(),
  publishedAt: z.string().datetime({ offset: true }).nullable().optional(),
  downloads: z.array(downloadEntry).max(10).optional(),
});

// 更新（downloads 提供时全量替换子表）
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { admin, ok } = await requirePerm("software:manage");
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const soft = await db.software.findUnique({ where: { id: Number(id) }, include: { category: true } });
  if (!soft) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const d = parsed.data;

  if (d.slug && d.slug !== soft.slug) {
    const dup = await db.software.findUnique({ where: { slug: d.slug } });
    if (dup) return NextResponse.json({ error: "slug 已存在" }, { status: 409 });
  }
  if (d.categoryId) {
    const cat = await db.softwareCategory.findUnique({ where: { id: d.categoryId } });
    if (!cat) return NextResponse.json({ error: "分类不存在" }, { status: 400 });
  }

  // 校验下载条目桶引用
  if (d.downloads !== undefined) {
    for (const dl of d.downloads) {
      if (dl.storageType === "bucket") {
        if (!dl.bucketId || !dl.objectKey) {
          return NextResponse.json({ error: `下载「${dl.label}」选择对象存储时必须选桶并填对象 Key` }, { status: 400 });
        }
        const b = await db.storageBucket.findUnique({ where: { id: dl.bucketId } });
        if (!b) return NextResponse.json({ error: `下载「${dl.label}」引用的存储桶不存在` }, { status: 400 });
      } else if (!dl.fileUrl) {
        return NextResponse.json({ error: `下载「${dl.label}」为本站文件时必须填文件路径` }, { status: 400 });
      }
    }
  }

  const data: any = {};
  if (d.slug !== undefined && d.slug) data.slug = d.slug;
  if (d.name !== undefined) data.name = d.name;
  if (d.version !== undefined) data.version = d.version || null;
  if (d.tagline !== undefined) data.tagline = d.tagline || null;
  if (d.description !== undefined) {
    data.description = isHtmlContent(d.description) ? sanitizeRich(d.description) : d.description;
  }
  if (d.icon !== undefined) data.icon = await localizeIcon(d.icon);
  if (d.categoryId !== undefined) data.categoryId = d.categoryId;
  if (d.tags !== undefined) data.tags = d.tags;
  if (d.sizeText !== undefined) data.sizeText = d.sizeText || null;
  if (d.platform !== undefined) data.platform = d.platform || null;
  if (d.language !== undefined) data.language = d.language || null;
  if (d.officialUrl !== undefined) data.officialUrl = d.officialUrl?.trim() || null;
  if (d.status !== undefined) data.status = d.status;
  if (d.viewCount !== undefined) data.viewCount = d.viewCount;
  if (d.downloadCount !== undefined) data.downloadCount = d.downloadCount;
  if (d.commentCount !== undefined) data.commentCount = d.commentCount;
  if (d.publishedAt !== undefined) data.publishedAt = d.publishedAt ? new Date(d.publishedAt) : null;
  // 首次发布补 publishedAt
  if (d.status === "published" && !soft.publishedAt && d.publishedAt === undefined) data.publishedAt = new Date();

  const updated = await db.$transaction(async (tx) => {
    if (d.downloads !== undefined) {
      await tx.softwareDownload.deleteMany({ where: { softwareId: soft.id } });
      if (d.downloads.length) {
        await tx.softwareDownload.createMany({
          data: d.downloads.map((dl, i) => ({
            softwareId: soft.id,
            label: dl.label,
            storageType: dl.storageType,
            fileUrl: dl.storageType === "local" ? dl.fileUrl : null,
            bucketId: dl.storageType === "bucket" ? dl.bucketId : null,
            objectKey: dl.storageType === "bucket" ? dl.objectKey : null,
            sizeBytes: dl.sizeBytes != null ? BigInt(dl.sizeBytes) : null,
            memberOnly: dl.memberOnly,
            sort: dl.sort ?? i,
          })),
        });
      }
    }
    return tx.software.update({
      where: { id: soft.id },
      data,
      include: { category: { select: { slug: true } } },
    });
  });

  try {
    if (updated.status === "published") {
      await syncSoftwareToMeili({ ...updated, categorySlug: updated.category.slug });
    } else {
      await removeSoftwareFromMeili(soft.id);
    }
  } catch (e) {
    console.warn("[meili] software update index failed:", soft.id, e);
  }

  await logAdminAction({
    adminId: admin.id, action: "update", targetType: "software", targetId: soft.id,
    detail: `更新软件「${updated.name}」`, ip: await getClientIp(),
  });
  return NextResponse.json({ ok: true });
}

// 删除（孤儿评论保留，由后台评论管理手动清理）
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { admin, ok } = await requirePerm("software:manage");
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const soft = await db.software.findUnique({ where: { id: Number(id) } });
  if (!soft) return NextResponse.json({ error: "not found" }, { status: 404 });

  await db.software.delete({ where: { id: soft.id } });
  try {
    await removeSoftwareFromMeili(soft.id);
  } catch (e) {
    console.warn("[meili] software delete index failed:", soft.id, e);
  }

  await logAdminAction({
    adminId: admin.id, action: "delete", targetType: "software", targetId: soft.id,
    detail: `删除软件「${soft.name}」`, ip: await getClientIp(),
  });
  return NextResponse.json({ ok: true });
}
