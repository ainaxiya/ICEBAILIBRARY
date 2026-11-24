import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm } from "@/lib/rbac";
import { num } from "@/lib/model-json";
import { dateRangeFilter } from "@/lib/date-range";

export const dynamic = "force-dynamic";

// ─── 后台调用使用记录明细 ───
// GET /api/admin/usage/records?userId=&channel=all|onsite|apikey&status=all|success|failed|blocked&q=&page=1&pageSize=20
// q 按 modelSnapshot / requestId 模糊；createdAt 倒序；keyPrefix 通过 apiKeyId 关联 UserApiKey 取
const CHANNELS = ["onsite", "apikey"];
const STATUSES = ["success", "failed", "blocked"];

export async function GET(req: NextRequest) {
  const { ok } = await requirePerm(PERMISSIONS.REPORT_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const channel = sp.get("channel") || "all";
  const status = sp.get("status") || "all";
  const q = (sp.get("q") || "").trim();
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

  const range = dateRangeFilter(sp.get("dateFrom"), sp.get("dateTo"));
  const where: Prisma.UsageRecordWhereInput = {
    ...(userId ? { userId } : {}),
    ...(range ? { createdAt: range } : {}),
    ...(CHANNELS.includes(channel) ? { channel } : {}),
    ...(STATUSES.includes(status) ? { status } : {}),
    ...(q
      ? {
          OR: [
            { modelSnapshot: { contains: q, mode: "insensitive" } },
            { requestId: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [total, list] = await Promise.all([
    db.usageRecord.count({ where }),
    db.usageRecord.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { user: { select: { username: true } } },
    }),
  ]);

  // apiKeyId（BigInt 列）→ UserApiKey.keyPrefix（无对应 Key 时为 null）
  const keyIds = [
    ...new Set(list.filter((r) => r.apiKeyId != null).map((r) => Number(r.apiKeyId))),
  ];
  const keys = keyIds.length
    ? await db.userApiKey.findMany({
        where: { id: { in: keyIds } },
        select: { id: true, keyPrefix: true },
      })
    : [];
  const keyMap = new Map(keys.map((k) => [k.id, k.keyPrefix]));

  return NextResponse.json({
    page,
    pageSize,
    total,
    items: list.map((r) => ({
      id: r.id,
      userId: r.userId,
      username: r.user?.username ?? "该会员号已注销",
      channel: r.channel,
      keyPrefix: r.apiKeyId != null ? keyMap.get(Number(r.apiKeyId)) ?? null : null,
      modelSnapshot: r.modelSnapshot,
      promptTokens: r.promptTokens,
      outputTokens: r.outputTokens,
      paidCredits: num(r.paidCredits),
      status: r.status,
      latencyMs: r.latencyMs,
      requestId: r.requestId,
      createdAt: r.createdAt,
    })),
  });
}
