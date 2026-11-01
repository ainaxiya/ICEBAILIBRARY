import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

const STATUS = ["online", "deprecated", "offline"] as const;

// GET /api/admin/models/vendors —— 厂商列表（含 Key/模型数量）
export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const status = req.nextUrl.searchParams.get("status") || undefined;
  const vendors = await db.aiVendor.findMany({
    where: status ? { status } : undefined,
    orderBy: { id: "asc" },
    include: { _count: { select: { keys: true, models: true } } },
  });

  return NextResponse.json({
    vendors: vendors.map((v) => ({
      id: v.id,
      name: v.name,
      slug: v.slug,
      apiBase: v.apiBase,
      protocol: v.protocol,
      status: v.status,
      remark: v.remark,
      keyCount: v._count.keys,
      modelCount: v._count.models,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    })),
  });
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(50),
  slug: z.string().trim().min(1).max(50),
  apiBase: z.string().trim().min(1).max(300),
  protocol: z.string().trim().max(30).optional(),
  status: z.enum(STATUS).optional(),
  remark: z.string().max(500).optional(),
});

// POST /api/admin/models/vendors —— 新建厂商
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const data = parsed.data;

  const dup = await db.aiVendor.findFirst({
    where: { OR: [{ name: data.name }, { slug: data.slug }] },
  });
  if (dup) return NextResponse.json({ error: "厂商名称或标识已存在" }, { status: 409 });

  const vendor = await db.aiVendor.create({
    data: {
      name: data.name,
      slug: data.slug,
      apiBase: data.apiBase,
      protocol: data.protocol || "openai",
      status: data.status || "online",
      remark: data.remark || null,
    },
  });

  await logAdminAction({
    adminId: admin.id,
    action: "create",
    targetType: "ai_vendor",
    targetId: vendor.id,
    detail: JSON.stringify({ name: vendor.name, slug: vendor.slug }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, vendor: { id: vendor.id, name: vendor.name, slug: vendor.slug } });
}
