import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// GET /api/admin/credits/packs —— 积分包列表（含下架）
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const packs = await db.creditPack.findMany({ orderBy: { sortOrder: "asc" } });
  return NextResponse.json({
    packs: packs.map((p) => ({
      id: p.id,
      packCode: p.packCode,
      priceCents: Number(p.priceCents),
      credits: Number(p.credits),
      isActive: p.isActive,
      sortOrder: p.sortOrder,
    })),
  });
}

const putSchema = z.object({
  id: z.number().int().positive(),
  priceCents: z.number().int().min(1).max(10_000_000).optional(),
  credits: z.number().int().min(1).max(100_000_000).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
});

// PUT /api/admin/credits/packs —— 更新积分包
export async function PUT(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { id, ...data } = parsed.data;
  const exists = await db.creditPack.findUnique({ where: { id } });
  if (!exists) return NextResponse.json({ error: "积分包不存在" }, { status: 404 });

  const updated = await db.creditPack.update({
    where: { id },
    data: {
      ...(data.priceCents !== undefined ? { priceCents: BigInt(data.priceCents) } : {}),
      ...(data.credits !== undefined ? { credits: BigInt(data.credits) } : {}),
      ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
  });

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "setting",
    targetId: id,
    detail: JSON.stringify({ section: "credit_pack", packCode: exists.packCode, keys: Object.keys(data) }),
    ip: await getClientIp(),
  });

  return NextResponse.json({
    ok: true,
    pack: {
      id: updated.id,
      packCode: updated.packCode,
      priceCents: Number(updated.priceCents),
      credits: Number(updated.credits),
      isActive: updated.isActive,
      sortOrder: updated.sortOrder,
    },
  });
}
