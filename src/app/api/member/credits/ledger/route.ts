import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { num } from "@/lib/model-json";
import { describeLedgerSources } from "@/lib/ledger-source";

export const dynamic = "force-dynamic";

// ─── 会员本人积分收支流水 ───
// GET /api/member/credits/ledger?reason=all|grant|consume|refund|admin_adjust&page=1&pageSize=20
// 按 createdAt 倒序分页；reason 默认 all（不过滤）
const REASONS = ["grant", "consume", "refund", "admin_adjust"];

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const reason = sp.get("reason") || "all";
  const page = Math.max(1, parseInt(sp.get("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(sp.get("pageSize") || "20") || 20));

  const where: Prisma.CreditLedgerWhereInput = {
    userId: user.id,
    // 只展示真实积分变动：changeAmount=0 的记录是结算/退款决策的内部标记（billing_decision），
    // 以及历史 0 分消费遗留行，前台不显示（历史数据保留在库里，不删）。
    changeAmount: { not: 0n },
    ...(REASONS.includes(reason) ? { reason } : {}),
  };

  const [total, list] = await Promise.all([
    db.creditLedger.count({ where }),
    db.creditLedger.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  // 来源简要中文（request→AI 对话·模型名；credit_grant→充值/订阅/赠送/试用；order→充值订单；admin→管理员调账）
  const sources = await describeLedgerSources(list);

  return NextResponse.json({
    page,
    pageSize,
    total,
    items: list.map((r, i) => ({
      id: r.id,
      changeAmount: num(r.changeAmount),
      balanceAfter: num(r.balanceAfter),
      reason: r.reason,
      refType: r.refType,
      refId: r.refId,
      source: sources[i],
      createdAt: r.createdAt,
    })),
  });
}
