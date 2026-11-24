import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// GET /api/admin/membership-levels?regular=1 — 等级列表
export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.USER_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const regular = req.nextUrl.searchParams.get("regular") === "1";
  const list = await db.membershipLevel.findMany({
    where: regular ? { isSystem: false } : undefined,
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    include: { _count: { select: { users: true } } },
  });
  return NextResponse.json({
    list: list.map((l) => ({
      code: l.code,
      name: l.name,
      isSystem: l.isSystem,
      canLogin: l.canLogin,
      isDefault: l.isDefault,
      grantCondition: l.grantCondition,
      sortOrder: l.sortOrder,
      isActive: l.isActive,
      remark: l.remark,
      userCount: l._count.users,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    })),
  });
}

const createSchema = z.object({
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,31}$/, "编码需小写字母开头，仅含小写字母/数字/下划线，2-32 位"),
  name: z.string().min(1, "请填写显示名").max(30),
  isSystem: z.boolean().default(false),
  canLogin: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  grantCondition: z.string().max(100).default(""),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
  remark: z.string().max(200).nullable().optional(),
});

// POST /api/admin/membership-levels — 新建等级
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.USER_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const d = parsed.data;
  if (d.isSystem && d.canLogin) {
    return NextResponse.json({ error: "系统等级不允许前台登录" }, { status: 400 });
  }
  const dup = await db.membershipLevel.findUnique({ where: { code: d.code } });
  if (dup) return NextResponse.json({ error: "等级编码已存在" }, { status: 400 });

  const created = await db.$transaction(async (tx) => {
    if (d.isDefault) {
      await tx.membershipLevel.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }
    return tx.membershipLevel.create({
      data: {
        code: d.code,
        name: d.name,
        isSystem: d.isSystem,
        canLogin: d.isSystem ? false : d.canLogin,
        isDefault: d.isDefault,
        grantCondition: d.grantCondition,
        sortOrder: d.sortOrder,
        isActive: d.isActive,
        remark: d.remark ?? null,
      },
    });
  });

  await logAdminAction({
    adminId: admin.id,
    action: "create",
    targetType: "membership_level",
    targetId: 0,
    detail: JSON.stringify({ code: created.code, name: created.name }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, code: created.code });
}
