import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { adminAdjust, getBalance } from "@/lib/credits";

export const dynamic = "force-dynamic";

// 积分调整入参：amount 为整数、可负、不可为 0；note 为调整原因（≤200 字）
const adjustSchema = z.object({
  amount: z
    .number({ invalid_type_error: "调整数量必须为整数" })
    .int("调整数量必须为整数")
    .refine((v) => v !== 0, "调整数量不能为 0"),
  note: z.string().trim().min(1, "请填写调整原因").max(200, "备注不超过 200 字"),
});

// GET /api/admin/users/:id/credits  查询会员当前积分余额
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { ok } = await requirePerm(PERMISSIONS.USER_WRITE);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const uid = parseInt(id);
  const target = await db.user.findUnique({ where: { id: uid } });
  if (!target || target.role !== "user") {
    return NextResponse.json({ error: "会员不存在" }, { status: 404 });
  }

  const balance = await getBalance(uid);
  return NextResponse.json({ balance: Number(balance) });
}

// POST /api/admin/users/:id/credits  管理员手工积分调账（正=入账 gift，负=扣减）
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { admin, ok } = await requirePerm(PERMISSIONS.USER_WRITE);
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const uid = parseInt(id);
  const target = await db.user.findUnique({ where: { id: uid } });
  if (!target || target.role !== "user") {
    return NextResponse.json({ error: "会员不存在" }, { status: 404 });
  }

  const parsed = adjustSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { amount, note } = parsed.data;

  // requestId 保证幂等：每次请求唯一，重复提交同一 requestId 不会重复调账
  const requestId = `admin-adjust:${admin.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const r = await adminAdjust(uid, BigInt(amount), note, requestId);
  if (!r.ok) {
    // 扣减余额不足等业务失败
    return NextResponse.json({ error: r.error || "调整失败" }, { status: 400 });
  }

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "user",
    targetId: uid,
    detail: JSON.stringify({ creditsAdjust: amount, note }),
    ip: (await getClientIp()) || undefined,
  });

  // 调整后重算余额返回
  const balance = await getBalance(uid);
  return NextResponse.json({ ok: true, balance: Number(balance) });
}
