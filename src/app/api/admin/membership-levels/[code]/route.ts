import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(30).optional(),
  canLogin: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  grantCondition: z.string().max(100).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
  remark: z.string().max(200).nullable().optional(),
});

// PATCH /api/admin/membership-levels/[code] — 改名/改获得条件/排序/启停/设默认
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.USER_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const { code } = await ctx.params;
  const existing = await db.membershipLevel.findUnique({ where: { code } });
  if (!existing) return NextResponse.json({ error: "等级不存在" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const d = parsed.data;

  if (d.isDefault === false && existing.isDefault) {
    return NextResponse.json({ error: "必须保留一个默认等级，请先指定其他默认等级" }, { status: 400 });
  }
  if (d.canLogin === true && existing.isSystem) {
    return NextResponse.json({ error: "系统等级不允许前台登录" }, { status: 400 });
  }

  await db.$transaction(async (tx) => {
    if (d.isDefault) {
      await tx.membershipLevel.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }
    await tx.membershipLevel.update({
      where: { code },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.canLogin !== undefined ? { canLogin: existing.isSystem ? false : d.canLogin } : {}),
        ...(d.isDefault !== undefined ? { isDefault: d.isDefault } : {}),
        ...(d.grantCondition !== undefined ? { grantCondition: d.grantCondition } : {}),
        ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
        ...(d.isActive !== undefined ? { isActive: d.isActive } : {}),
        ...(d.remark !== undefined ? { remark: d.remark } : {}),
      },
    });
  });

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "membership_level",
    targetId: 0,
    detail: JSON.stringify({ code, ...d }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true });
}

// DELETE /api/admin/membership-levels/[code] — 删除（默认等级/被账号引用时拦截）
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.USER_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const { code } = await ctx.params;
  const existing = await db.membershipLevel.findUnique({
    where: { code },
    include: { _count: { select: { users: true } } },
  });
  if (!existing) return NextResponse.json({ error: "等级不存在" }, { status: 404 });
  if (existing.isDefault) {
    return NextResponse.json({ error: "默认等级禁止删除（可改名）" }, { status: 400 });
  }
  if (existing._count.users > 0) {
    return NextResponse.json(
      { error: `该等级下还有 ${existing._count.users} 个账号，请先调整这些账号的等级` },
      { status: 400 }
    );
  }

  await db.membershipLevel.delete({ where: { code } });
  await logAdminAction({
    adminId: admin.id,
    action: "delete",
    targetType: "membership_level",
    targetId: 0,
    detail: JSON.stringify({ code }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true });
}
