import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/member/pay/orders —— 我的充值记录（分页：?page=&pageSize=，默认第 1 页 50 条）
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(sp.get("pageSize") || "50") || 50));

  const where = { userId: user.id };
  const [total, orders] = await Promise.all([
    db.payOrder.count({ where }),
    db.payOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { pack: { select: { packCode: true, credits: true, bonusCredits: true } } },
    }),
  ]);

  return NextResponse.json({
    page,
    pageSize,
    total,
    orders: orders.map((o) => ({
      orderNo: o.orderNo,
      packCode: o.pack.packCode,
      credits: Number(o.pack.credits),
      bonusCredits: Number(o.pack.bonusCredits),
      amountCents: Number(o.amountCents),
      channel: o.channel,
      status: o.status,
      paidAt: o.paidAt,
      createdAt: o.createdAt,
    })),
  });
}
