import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm } from "@/lib/rbac";
import { num } from "@/lib/model-json";
import { describeLedgerSources } from "@/lib/ledger-source";
import { dateRangeFilter } from "@/lib/date-range";

export const dynamic = "force-dynamic";

// ─── 后台积分明细（可按会员筛选） ───
// GET /api/admin/credits/ledger?userId=&reason=all|grant|consume|refund|admin_adjust&page=1&pageSize=20
// 按 createdAt 倒序分页；每条附带会员 userId / username
const REASONS = ["grant", "consume", "refund", "admin_adjust"];

export async function GET(req: NextRequest) {
  const { ok } = await requirePerm(PERMISSIONS.USER_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const reason = sp.get("reason") || "all";
  const page = Math.max(1, parseInt(sp.get("page") || "1") || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(sp.get("pageSize") || "20") || 20));

  // 可选会员筛选：传了就必须是正整数
  const userIdRaw = (sp.get("userId") || "").trim();
  let userId = 0;
  if (userIdRaw) {
    userId = parseInt(userIdRaw);
    if (!Number.isInteger(userId) || userId <= 0) {
      return NextResponse.json({ error: "会员 userId 无效" }, { status: 400 });
    }
  }

  const where: Prisma.CreditLedgerWhereInput = {
    ...(userId ? { userId } : {}),
    ...(REASONS.includes(reason) ? { reason } : {}),
    ...(dateRangeFilter(sp.get("dateFrom"), sp.get("dateTo"))
      ? { createdAt: dateRangeFilter(sp.get("dateFrom"), sp.get("dateTo")) }
      : {}),
  };

  const [total, list] = await Promise.all([
    db.creditLedger.count({ where }),
    db.creditLedger.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { user: { select: { username: true } } },
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
      userId: r.userId,
      username: r.user?.username ?? "该会员号已注销",
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
