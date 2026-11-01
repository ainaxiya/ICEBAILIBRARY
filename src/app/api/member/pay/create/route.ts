import { randomInt } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { ensureCreditPacks } from "@/lib/credits";
import { getAdapter, isPayChannel } from "@/lib/payments";

export const dynamic = "force-dynamic";

// POST /api/member/pay/create —— 选积分包 + 通道 → 建 PayOrder → 返回模拟支付参数
const schema = z.object({
  packCode: z.string().min(1),
  channel: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }
  const { packCode, channel } = parsed.data;
  if (!isPayChannel(channel)) {
    return NextResponse.json({ error: "支付通道不支持" }, { status: 400 });
  }

  await ensureCreditPacks();
  const pack = await db.creditPack.findUnique({ where: { packCode } });
  if (!pack || !pack.isActive) {
    return NextResponse.json({ error: "积分包不存在或已下架" }, { status: 404 });
  }

  const adapter = getAdapter(channel)!;
  const orderNo = `CP${Date.now()}${randomInt(1000, 9999)}`;
  const order = await db.payOrder.create({
    data: {
      orderNo,
      userId: user.id,
      packId: pack.id,
      amountCents: pack.priceCents,
      channel,
      status: "pending",
    },
  });

  const siteBase = (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
  const pay = await adapter.createPayment(
    {
      orderNo: order.orderNo,
      amountCents: order.amountCents,
      subject: `积分包 ${pack.packCode}`,
      userId: user.id,
    },
    `${siteBase}/recharge?paid=${order.orderNo}`
  );
  if (!pay.ok) {
    await db.payOrder.update({ where: { id: order.id }, data: { status: "closed" } });
    return NextResponse.json({ error: pay.error || "创建支付失败" }, { status: 400 });
  }

  return NextResponse.json({
    order: {
      orderNo: order.orderNo,
      packCode: pack.packCode,
      amountCents: Number(order.amountCents),
      credits: Number(pack.credits),
      channel: order.channel,
      status: order.status,
    },
    pay: { payUrl: pay.payUrl, params: pay.params },
  });
}
