import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { syncSoftwareToMeili } from "@/lib/meili";
import { sanitizeRich } from "@/lib/sanitize.server";
import { isHtmlContent } from "@/lib/rich";
import { localizeIcon } from "@/lib/icon-localize.server";

export const dynamic = "force-dynamic";

// GET /api/admin/software?page=&q=&status=&categoryId=
export async function GET(req: NextRequest) {
  const { ok } = await requirePerm("software:manage");
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
  if (q) where.OR = [{ name: { contains: q, mode: "insensitive" } }, { tagline: { contains: q, mode: "insensitive" } }];

  const [list, total, counts] = await Promise.all([
    db.software.findMany({
      where,
      orderBy: [{ id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        category: { select: { id: true, name: true, slug: true } },
        _count: { select: { downloads: true } },
      },
    }),
    db.software.count({ where }),
    db.software.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  return NextResponse.json({
    list: list.map(({ _count, ...s }) => ({ ...s, downloadEntries: _count.downloads })),
    total, page, pageSize,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
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

const upsertSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/, "slug 必须为小写字母/数字/连字符").optional().or(z.literal("")),
  name: z.string().min(1).max(200),
  version: z.string().max(50).nullable().optional(),
  tagline: z.string().max(300).nullable().optional(),
  description: z.string().min(1).max(200_000),
  icon: z.string().max(500).nullable().optional(),
  categoryId: z.number().int().positive(),
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

function autoSlug(name: string) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s.length >= 2 ? s : `soft-${Date.now().toString(36)}`;
}

// POST 新建（仅后台可添加；图标外链自动本地化）
export async function POST(req: NextRequest) {
  const { admin, ok } = await requirePerm("software:manage");
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = upsertSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const d = parsed.data;

  const cat = await db.softwareCategory.findUnique({ where: { id: d.categoryId } });
  if (!cat) return NextResponse.json({ error: "分类不存在" }, { status: 400 });

  const slug = d.slug?.trim() || autoSlug(d.name);
  const dup = await db.software.findUnique({ where: { slug } });
  if (dup) return NextResponse.json({ error: "slug 已存在" }, { status: 409 });

  // 校验桶引用
  const downloads = d.downloads || [];
  for (const dl of downloads) {
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

  const icon = await localizeIcon(d.icon);
  const description = isHtmlContent(d.description) ? sanitizeRich(d.description) : d.description;
  const status = d.status || "published";

  const soft = await db.software.create({
    data: {
      slug,
      name: d.name,
      version: d.version || null,
      tagline: d.tagline || null,
      description,
      icon,
      categoryId: cat.id,
      tags: d.tags || [],
      sizeText: d.sizeText || null,
      platform: d.platform || null,
      language: d.language || null,
      officialUrl: d.officialUrl?.trim() || null,
      status,
      viewCount: d.viewCount || 0,
      downloadCount: d.downloadCount || 0,
      commentCount: d.commentCount || 0,
      publishedAt: d.publishedAt ? new Date(d.publishedAt) : status === "published" ? new Date() : null,
      downloads: {
        create: downloads.map((dl, i) => ({
          label: dl.label,
          storageType: dl.storageType,
          fileUrl: dl.storageType === "local" ? dl.fileUrl : null,
          bucketId: dl.storageType === "bucket" ? dl.bucketId : null,
          objectKey: dl.storageType === "bucket" ? dl.objectKey : null,
          sizeBytes: dl.sizeBytes != null ? BigInt(dl.sizeBytes) : null,
          memberOnly: dl.memberOnly,
          sort: dl.sort ?? i,
        })),
      },
    },
  });

  if (status === "published") {
    try {
      await syncSoftwareToMeili({ ...soft, categorySlug: cat.slug });
    } catch (e) {
      console.warn("[meili] software create index failed:", soft.id, e);
    }
  }

  await logAdminAction({
    adminId: admin.id, action: "create", targetType: "software", targetId: soft.id,
    detail: `新建软件「${d.name}」`, ip: await getClientIp(),
  });
  return NextResponse.json({ id: soft.id, slug: soft.slug, status });
}
