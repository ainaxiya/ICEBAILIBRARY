import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, requireSensitivePerm, reauthRequired, logAdminAction, getClientIp } from "@/lib/rbac";
import {
  adminAdjust,
  adminSetBalance,
  getBalance,
  previewAdjustment,
  type AdminAdjustMode,
} from "@/lib/credits";
import { withChanges } from "@/lib/audit-diff";

export const dynamic = "force-dynamic";

// 积分调整入参：mode 缺省按历史「带符号数量」口径（正=入账，负=扣减）
const adjustSchema = z.object({
  mode: z.enum(["increase", "deduct", "set"]).optional(),
  amount: z
    .number({ invalid_type_error: "调整数量必须为整数" })
    .int("调整数量必须为整数"),
  note: z.string().trim().min(1, "请填写调整原因").max(200, "备注不超过 200 字"),
});

// GET /api/admin/users/:id/credits           查询余额 + 是否超管（覆盖模式可见性）
// GET /api/admin/users/:id/credits?mode=&amount=  调整前后预览（不落库）
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { admin, ok } = await requirePerm(PERMISSIONS.USER_WRITE);
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const uid = parseInt(id);
  const target = await db.user.findUnique({
    where: { id: uid },
    include: { membership: { select: { isSystem: true } } },
  });
  if (!target || target.membership?.isSystem) {
    return NextResponse.json({ error: "会员不存在" }, { status: 404 });
  }

  const balance = await getBalance(uid);
  const canOverride = Boolean(admin.isSuper);

  const sp = req.nextUrl.searchParams;
  const modeRaw = sp.get("mode");
  const amountRaw = sp.get("amount");
  if (!modeRaw || amountRaw === null) {
    return NextResponse.json({ balance: Number(balance), canOverride });
  }

  const mode = modeRaw as AdminAdjustMode;
  if (!["increase", "deduct", "set"].includes(mode)) {
    return NextResponse.json({ error: "未知的调整模式" }, { status: 400 });
  }
  if (mode === "set" && !canOverride) {
    return NextResponse.json({ error: "仅超级管理员可使用覆盖模式" }, { status: 403 });
  }
  const amount = Number(amountRaw);
  if (!Number.isInteger(amount)) {
    return NextResponse.json({ error: "调整数量必须为整数" }, { status: 400 });
  }

  const preview = previewAdjustment(balance, mode, BigInt(amount));
  return NextResponse.json({
    balance: Number(balance),
    canOverride,
    preview: {
      ok: preview.ok,
      delta: Number(preview.delta),
      after: Number(preview.after),
      error: preview.error ?? null,
    },
  });
}

// POST /api/admin/users/:id/credits  管理员额度调整
// mode=increase 增加 / mode=deduct 扣减 / mode=set 覆盖为目标余额（仅超管）
// 无 mode 时沿用历史带符号口径；三种模式都必须填审计备注，统一写 credit_ledger（admin_adjust）。
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // 积分调整属敏感操作：除 user:write 外还要求 10 分钟内二次密码验证
  const { admin, ok, needReauth } = await requireSensitivePerm(PERMISSIONS.USER_WRITE);
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (needReauth) return reauthRequired();

  const { id } = await ctx.params;
  const uid = parseInt(id);
  const target = await db.user.findUnique({
    where: { id: uid },
    include: { membership: { select: { isSystem: true } } },
  });
  if (!target || target.membership?.isSystem) {
    return NextResponse.json({ error: "会员不存在" }, { status: 404 });
  }

  const parsed = adjustSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { mode, amount, note } = parsed.data;

  if (mode === "set" && !admin.isSuper) {
    return NextResponse.json({ error: "仅超级管理员可使用覆盖模式" }, { status: 403 });
  }
  if (mode && amount < 0) {
    return NextResponse.json({ error: "调整数量必须为非负整数" }, { status: 400 });
  }
  if ((!mode || mode !== "set") && amount === 0) {
    return NextResponse.json({ error: "调整数量不能为 0" }, { status: 400 });
  }

  const before = await getBalance(uid);
  const signed = mode === "deduct" ? -BigInt(amount) : BigInt(amount);
  if (mode) {
    const preview = previewAdjustment(before, mode, BigInt(amount));
    if (!preview.ok) return NextResponse.json({ error: preview.error }, { status: 400 });
  }

  // requestId 保证幂等：每次请求唯一，重复提交同一 requestId 不会重复调账
  const requestId = `admin-adjust:${admin.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const r =
    mode === "set"
      ? await adminSetBalance(uid, BigInt(amount), note, requestId)
      : await adminAdjust(uid, signed, note, requestId);
  if (!r.ok) {
    return NextResponse.json({ error: r.error || "调整失败" }, { status: 400 });
  }

  const balance = await getBalance(uid);
  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "user",
    targetId: uid,
    detail: withChanges({ creditsAdjust: Number(signed), creditsMode: mode ?? "signed", note }, [
      { field: "balance", label: "积分余额", before: Number(before), after: Number(balance) },
    ]),
    ip: (await getClientIp()) || undefined,
  });

  return NextResponse.json({
    ok: true,
    before: Number(before),
    after: Number(balance),
    delta: Number(balance - before),
    balance: Number(balance),
  });
}
