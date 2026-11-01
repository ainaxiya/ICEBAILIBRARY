import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

const STATUS = ["online", "deprecated", "offline"] as const;

const updateSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  slug: z.string().trim().min(1).max(50).optional(),
  apiBase: z.string().trim().min(1).max(300).optional(),
  protocol: z.string().trim().max(30).optional(),
  status: z.enum(STATUS).optional(),
  remark: z.string().max(500).nullable().optional(),
});

// PUT /api/admin/models/vendors/[id]
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const { id } = await params;
  const vendorId = Number(id);
  if (!Number.isInteger(vendorId)) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const exists = await db.aiVendor.findUnique({ where: { id: vendorId } });
  if (!exists) return NextResponse.json({ error: "厂商不存在" }, { status: 404 });

  const data = parsed.data;
  if (data.name || data.slug) {
    const dup = await db.aiVendor.findFirst({
      where: {
        OR: [
          ...(data.name ? [{ name: data.name }] : []),
          ...(data.slug ? [{ slug: data.slug }] : []),
        ],
        NOT: { id: vendorId },
      },
    });
    if (dup) return NextResponse.json({ error: "厂商名称或标识已存在" }, { status: 409 });
  }

  const vendor = await db.aiVendor.update({
    where: { id: vendorId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.slug !== undefined ? { slug: data.slug } : {}),
      ...(data.apiBase !== undefined ? { apiBase: data.apiBase } : {}),
      ...(data.protocol !== undefined ? { protocol: data.protocol } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.remark !== undefined ? { remark: data.remark } : {}),
    },
  });

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "ai_vendor",
    targetId: vendorId,
    detail: JSON.stringify({ keys: Object.keys(data) }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, vendor: { id: vendor.id, name: vendor.name, status: vendor.status } });
}

// DELETE /api/admin/models/vendors/[id] —— 级联删除 Key/模型（schema onDelete: Cascade）
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const { id } = await params;
  const vendorId = Number(id);
  if (!Number.isInteger(vendorId)) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  const exists = await db.aiVendor.findUnique({
    where: { id: vendorId },
    include: { _count: { select: { keys: true, models: true } } },
  });
  if (!exists) return NextResponse.json({ error: "厂商不存在" }, { status: 404 });

  await db.aiVendor.delete({ where: { id: vendorId } });

  await logAdminAction({
    adminId: admin.id,
    action: "delete",
    targetType: "ai_vendor",
    targetId: vendorId,
    detail: JSON.stringify({ name: exists.name, keys: exists._count.keys, models: exists._count.models }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true });
}
