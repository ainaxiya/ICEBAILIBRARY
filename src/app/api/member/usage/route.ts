import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// ─── P4 用户中心：用量明细 ───
// GET /api/member/usage?channel=onsite|apikey&view=list|bykey|byday&page=1
// onsite = 本站使用（对话/生图/生视频）；apikey = API Key 使用（含按 Key/按日聚合）

// endpointType → 功能名（对齐 TRAE 信息量）
const FEATURE: Record<string, string> = {
  chat: "对话",
  image: "生图",
  video: "生视频",
  audio: "音频",
};

const PAGE_SIZE = 20;

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const channel = sp.get("channel") === "apikey" ? "apikey" : "onsite";
  const view = sp.get("view") || "list";
  const page = Math.max(1, parseInt(sp.get("page") || "1") || 1);

  if (channel === "apikey" && view === "bykey") {
    // 按 Key 聚合
    const groups = await db.usageRecord.groupBy({
      by: ["apiKeyId"],
      where: { userId: user.id, channel: "apikey" },
      _count: { _all: true },
      _sum: { promptTokens: true, outputTokens: true, paidCredits: true },
      orderBy: { _count: { id: "desc" } },
      take: 50,
    });
    return NextResponse.json({
      view: "bykey",
      rows: groups.map((g) => ({
        keyName: g.apiKeyId != null ? `API Key #${g.apiKeyId}` : "未知 Key",
        calls: g._count._all,
        tokens: (g._sum.promptTokens ?? 0) + (g._sum.outputTokens ?? 0),
        credits: Number(g._sum.paidCredits ?? 0n),
      })),
    });
  }

  if (channel === "apikey" && view === "byday") {
    // 按日聚合
    const rows = await db.$queryRaw<
      { day: Date; calls: bigint; tokens: bigint; credits: bigint }[]
    >`
      SELECT date("createdAt") AS day,
             COUNT(*)::bigint AS calls,
             (COALESCE(SUM("promptTokens"), 0) + COALESCE(SUM("outputTokens"), 0))::bigint AS tokens,
             COALESCE(SUM("paidCredits"), 0)::bigint AS credits
      FROM usage_record
      WHERE "userId" = ${user.id} AND channel = 'apikey'
      GROUP BY 1 ORDER BY 1 DESC LIMIT 60
    `;
    return NextResponse.json({
      view: "byday",
      rows: rows.map((r) => ({
        day: r.day.toISOString().slice(0, 10),
        calls: Number(r.calls),
        tokens: Number(r.tokens),
        credits: Number(r.credits),
      })),
    });
  }

  // 明细列表
  const where = { userId: user.id, channel };
  const [total, records] = await Promise.all([
    db.usageRecord.count({ where }),
    db.usageRecord.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  return NextResponse.json({
    view: "list",
    channel,
    page,
    pageSize: PAGE_SIZE,
    total,
    rows: records.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      feature: FEATURE[r.endpointType] || r.endpointType,
      endpointType: r.endpointType,
      keyName: channel === "apikey" ? (r.apiKeyId != null ? `API Key #${r.apiKeyId}` : "未知 Key") : null,
      model: r.modelSnapshot,
      promptTokens: r.promptTokens,
      outputTokens: r.outputTokens,
      tokens: r.promptTokens + r.outputTokens,
      credits: Number(r.paidCredits),
      status: r.status,
    })),
  });
}
