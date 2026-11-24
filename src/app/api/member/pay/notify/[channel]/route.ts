import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { grant } from "@/lib/credits";
import { getAdapter } from "@/lib/payments";

export const dynamic = "force-dynamic";

// POST /api/member/pay/notify/[channel] —— 支付回调
// 流程：verifyCallback 验签 → 金额核对 → providerEventId 幂等
//   → grant(topup, sourceRef=orderNo)（幂等）→ status=paid
type Ctx = { params: Promise<{ channel: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { channel } = await ctx.params;
  const adapter = getAdapter(channel);
  if (!adapter) {
    return NextResponse.json({ error: "未知支付通道" }, { status: 404 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "回调报文不合法" }, { status: 400 });
  }

  const verify = await adapter.verifyCallback(req, body as Record<string, unknown>);
  if (!verify.ok || !verify.orderNo) {
    return NextResponse.json({ error: verify.error || "回调验签失败" }, { status: 400 });
  }

  const order = await db.payOrder.findUnique({ where: { orderNo: verify.orderNo } });
  if (!order || order.channel !== channel) {
    return NextResponse.json({ error: "订单不存在" }, { status: 404 });
  }
  if (Number(order.amountCents) !== verify.amountCents) {
    return NextResponse.json({ error: "金额不匹配" }, { status: 400 });
  }
  // 幂等：已支付直接成功（重复回调）
  if (order.status === "paid") {
    return NextResponse.json({ ok: true, message: "already paid" });
  }
  // providerEventId 幂等：同一事件只处理一次
  if (verify.eventId) {
    const dup = await db.payOrder.findUnique({ where: { providerEventId: verify.eventId } });
    if (dup && dup.id !== order.id) {
      return NextResponse.json({ error: "回调事件已处理" }, { status: 400 });
    }
  }

  const pack = await db.creditPack.findUnique({ where: { id: order.packId } });
  if (!pack) {
    return NextResponse.json({ error: "积分包不存在" }, { status: 500 });
  }

  // 会员已注销但订单仍待支付：不能再入账，直接返回并关闭订单
  if (!order.userId) {
    await db.payOrder.updateMany({
      where: { id: order.id, status: "pending" },
      data: { status: "closed", providerEventId: verify.eventId || null },
    });
    return NextResponse.json({ error: "订单所属会员已注销" }, { status: 400 });
  }

  // 先发积分（grant 幂等，崩溃后可安全重试），再标记已支付；v0.92 #2 购买积分 + 赠送积分
  await grant(order.userId, "topup", pack.credits + pack.bonusCredits, order.orderNo);
  await db.payOrder.updateMany({
    where: { id: order.id, status: "pending" },
    data: { status: "paid", providerEventId: verify.eventId || null, paidAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
