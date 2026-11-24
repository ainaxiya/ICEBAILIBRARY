import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { num } from "@/lib/model-json";
import { dateRangeFilter } from "@/lib/date-range";

export const dynamic = "force-dynamic";

// ─── 后台充值订单管理 ───
// GET  /api/admin/pay/orders?q=&status=all|pending|paid|failed|closed&channel=&page=1&pageSize=20
// POST /api/admin/pay/orders  { action: "markPaid" | "close", orderNo }
//   markPaid = 手动补单（支付回调丢失时人工入账积分）；close = 关单（订单不可再支付）

// GET：订单列表（订单号/会员名模糊搜索、状态/通道筛选、分页，createdAt 倒序）
export async function GET(req: NextRequest) {
  const { ok } = await requirePerm(PERMISSIONS.USER_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") || "").trim();
  const status = sp.get("status") || "all";
  const channel = (sp.get("channel") || "").trim();
  const page = Math.max(1, parseInt(sp.get("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(sp.get("pageSize") || "20") || 20));
  // 会员详情页：按会员 + 时间区间筛选
  const userId = parseInt(sp.get("userId") || "0", 10) || 0;
  const range = dateRangeFilter(sp.get("dateFrom"), sp.get("dateTo"));

  const where: Prisma.PayOrderWhereInput = {
    ...(userId > 0 ? { userId } : {}),
    ...(range ? { createdAt: range } : {}),
    ...(status !== "all" && status ? { status } : {}),
    ...(channel !== "all" && channel ? { channel } : {}),
    ...(q
      ? {
          OR: [
            { orderNo: { contains: q, mode: "insensitive" } },
            { user: { username: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [total, list] = await Promise.all([
    db.payOrder.count({ where }),
    db.payOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        user: { select: { username: true } },
        pack: { select: { packCode: true, credits: true, bonusCredits: true } },
      },
    }),
  ]);

  return NextResponse.json({
    page,
    pageSize,
    total,
    items: list.map((o) => ({
      id: o.id,
      orderNo: o.orderNo,
      userId: o.userId,
      username: o.user?.username ?? "该会员号已注销",
      packCode: o.pack.packCode,
      amountCents: num(o.amountCents),
      credits: num(o.pack.credits),
      bonusCredits: num(o.pack.bonusCredits),
      channel: o.channel,
      status: o.status,
      paidAt: o.paidAt,
      createdAt: o.createdAt,
    })),
  });
}

const postSchema = z.object({
  action: z.enum(["markPaid", "close"]),
  orderNo: z.string().trim().min(1, "订单号不能为空"),
});

// POST：补单入账 / 关单
export async function POST(req: NextRequest) {
  const { admin, ok } = await requirePerm(PERMISSIONS.USER_WRITE);
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { action, orderNo } = parsed.data;

  const order = await db.payOrder.findUnique({
    where: { orderNo },
    include: { pack: { select: { packCode: true, credits: true, bonusCredits: true } } },
  });
  if (!order) return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  if (order.status === "paid") return NextResponse.json({ error: "订单已支付" }, { status: 400 });
  if (order.status !== "pending") {
    return NextResponse.json({ error: "仅待支付订单可操作" }, { status: 400 });
  }

  const ip = (await getClientIp()) || undefined;

  if (action === "close") {
    // 乐观锁：仅 pending 可关
    const upd = await db.payOrder.updateMany({
      where: { id: order.id, status: "pending" },
      data: { status: "closed" },
    });
    if (upd.count === 0) return NextResponse.json({ error: "订单状态已变更，请刷新后重试" }, { status: 400 });

    await logAdminAction({
      adminId: admin.id,
      action: "update",
      targetType: "pay_order",
      targetId: order.id,
      detail: JSON.stringify({ op: "close", orderNo }),
      ip,
    });
    return NextResponse.json({ ok: true });
  }

  const orderUserId = order.userId;
  if (orderUserId === null) {
    return NextResponse.json({ error: "订单所属会员已注销，无法补单入账" }, { status: 400 });
  }

  // ── markPaid 手动补单：事务内完成 置已支付 → 发积分（CreditGrant）→ 写流水 → 通知会员 ──
  // 入账字段与支付回调（/api/member/pay/notify/[channel]）一致：grantType=topup、sourceRef=orderNo、金额=pack.credits
  let result: "ok" | "granted" | "conflict";
  try {
    result = await db.$transaction(async (tx) => {
      // 乐观锁：仅 pending 可补单
      const upd = await tx.payOrder.updateMany({
        where: { id: order.id, status: "pending" },
        data: { status: "paid", paidAt: new Date() },
      });
      if (upd.count === 0) return "conflict";

      // 幂等：CreditGrant 的 (userId, grantType, sourceRef) 唯一，已存在说明积分发过（如回调已入账）→ 视为完成
      const existing = await tx.creditGrant.findUnique({
        where: {
          userId_grantType_sourceRef: {
            userId: orderUserId,
            grantType: "topup",
            sourceRef: order.orderNo,
          },
        },
      });
      if (existing) return "granted";

      await tx.creditGrant.create({
        data: {
          userId: orderUserId,
          grantType: "topup",
          // v0.92 #2：购买积分 + 赠送积分
          totalCredits: order.pack.credits + order.pack.bonusCredits,
          remainingCredits: order.pack.credits + order.pack.bonusCredits,
          expiresAt: null,
          sourceRef: order.orderNo,
        },
      });

      // 新余额 = 有效 grant 剩余之和（与 getBalance 口径一致）
      const agg = await tx.creditGrant.aggregate({
        where: {
          userId: orderUserId,
          remainingCredits: { gt: 0 },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        _sum: { remainingCredits: true },
      });
      const balanceAfter = agg._sum.remainingCredits ?? 0n;

      await tx.creditLedger.create({
        data: {
          userId: orderUserId,
          changeAmount: order.pack.credits + order.pack.bonusCredits,
          balanceAfter,
          reason: "grant",
          refType: "order",
          refId: order.orderNo,
          requestId: `markPaid:${order.orderNo}`,
        },
      });

      // 会员到账通知（字段同后台单发通知：admin_to_user / notice）
      await tx.userMessage.create({
        data: {
          userId: orderUserId,
          direction: "admin_to_user",
          msgType: "notice",
          subject: "充值到账通知",
          body: `订单 ${order.orderNo}（${order.pack.packCode}）已补单入账，${num(order.pack.credits + order.pack.bonusCredits)} 积分已到账。`,
        },
      });

      return "ok";
    });
  } catch (e) {
    // 唯一约束冲突 = 并发补单已入账，视为已完成
    if ((e as { code?: string })?.code === "P2002") return NextResponse.json({ ok: true });
    throw e;
  }

  if (result === "conflict") {
    return NextResponse.json({ error: "订单状态已变更，请刷新后重试" }, { status: 400 });
  }

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "pay_order",
    targetId: order.id,
    detail: JSON.stringify({ op: "markPaid", orderNo }),
    ip,
  });
  return NextResponse.json({ ok: true });
}
