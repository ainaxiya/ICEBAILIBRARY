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

const postSchema = z.object({
  // 商品码：唯一，字母/数字/下划线/连字符
  packCode: z
    .string()
    .trim()
    .min(1, "商品码不能为空")
    .max(50, "商品码最长 50 字符")
    .regex(/^[A-Za-z0-9_-]+$/, "商品码仅限字母、数字、下划线、连字符"),
  priceCents: z.number().int().min(1).max(10_000_000),
  credits: z.number().int().min(1).max(100_000_000),
  sortOrder: z.number().int().min(0).max(9999).optional().default(0),
  isActive: z.boolean().optional().default(true),
});

// POST /api/admin/credits/packs —— 新建积分包
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { packCode, priceCents, credits, sortOrder, isActive } = parsed.data;

  // 商品码唯一性校验
  const exists = await db.creditPack.findUnique({ where: { packCode } });
  if (exists) return NextResponse.json({ error: "商品码已存在" }, { status: 409 });

  const created = await db.creditPack.create({
    data: {
      packCode,
      priceCents: BigInt(priceCents),
      credits: BigInt(credits),
      sortOrder,
      isActive,
    },
  });

  await logAdminAction({
    adminId: admin.id,
    action: "create",
    targetType: "setting",
    targetId: created.id,
    detail: JSON.stringify({ section: "credit_pack", packCode, priceCents, credits, sortOrder, isActive }),
    ip: await getClientIp(),
  });

  return NextResponse.json({
    ok: true,
    pack: {
      id: created.id,
      packCode: created.packCode,
      priceCents: Number(created.priceCents),
      credits: Number(created.credits),
      isActive: created.isActive,
      sortOrder: created.sortOrder,
    },
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
