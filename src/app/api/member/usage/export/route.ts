import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { buildCsv, csvTime } from "@/lib/csv";

export const dynamic = "force-dynamic";

// ─── b6：用量导出 CSV ───
// GET /api/member/usage/export?channel=onsite|apikey&view=list|byday|bykey|bymodel
// 仅导出当前登录用户自己的数据；列表最多 5000 行，聚合视图最多 60 组。

const FEATURE: Record<string, string> = {
  chat: "对话",
  image: "生图",
  video: "生视频",
  audio: "音频",
};

const EXPORT_LIMIT = 5000;

function csvResponse(filename: string, body: string) {
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const channel = sp.get("channel") === "apikey" ? "apikey" : "onsite";
  const view = sp.get("view") || "list";
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const filename = `usage-${channel}-${view}-${stamp}.csv`;

  if (view === "byday") {
    const rows = await db.$queryRaw<
      { day: Date; calls: bigint; tokens: bigint; credits: bigint }[]
    >`
      SELECT date("createdAt") AS day,
             COUNT(*)::bigint AS calls,
             (COALESCE(SUM("promptTokens"), 0) + COALESCE(SUM("outputTokens"), 0))::bigint AS tokens,
             COALESCE(SUM("paidCredits"), 0)::bigint AS credits
      FROM usage_record
      WHERE "userId" = ${user.id} AND channel = ${channel}
      GROUP BY 1 ORDER BY 1 DESC LIMIT 60
    `;
    return csvResponse(
      filename,
      buildCsv(
        ["日期", "调用数", "总 tokens", "扣积分"],
        rows.map((r) => [r.day.toISOString().slice(0, 10), Number(r.calls), Number(r.tokens), Number(r.credits)])
      )
    );
  }

  if (view === "bymodel" && channel === "onsite") {
    const rows = await db.$queryRaw<
      { modelName: string; calls: bigint; tokens: bigint; credits: bigint }[]
    >`
      SELECT "modelSnapshot" AS "modelName",
             COUNT(*)::bigint AS calls,
             (COALESCE(SUM("promptTokens"), 0) + COALESCE(SUM("outputTokens"), 0))::bigint AS tokens,
             COALESCE(SUM("paidCredits"), 0)::bigint AS credits
      FROM usage_record
      WHERE "userId" = ${user.id} AND channel = 'onsite'
      GROUP BY 1 ORDER BY 4 DESC LIMIT 60
    `;
    return csvResponse(
      filename,
      buildCsv(
        ["模型", "调用数", "总 tokens", "扣积分"],
        rows.map((r) => [r.modelName, Number(r.calls), Number(r.tokens), Number(r.credits)])
      )
    );
  }

  if (view === "bykey" && channel === "apikey") {
    const [groups, keys] = await Promise.all([
      db.usageRecord.groupBy({
        by: ["apiKeyId"],
        where: { userId: user.id, channel: "apikey" },
        _count: { _all: true },
        _sum: { promptTokens: true, outputTokens: true, paidCredits: true },
        orderBy: { _count: { id: "desc" } },
        take: 50,
      }),
      db.userApiKey.findMany({ where: { userId: user.id }, select: { id: true, name: true, keyPrefix: true } }),
    ]);
    const keyMap = new Map(keys.map((k) => [String(k.id), k]));
    return csvResponse(
      filename,
      buildCsv(
        ["API Key", "调用数", "总 tokens", "扣积分"],
        groups.map((g) => {
          const k = g.apiKeyId != null ? keyMap.get(String(g.apiKeyId)) : undefined;
          const label = k ? `${k.name || "未命名"}（${k.keyPrefix}…）` : g.apiKeyId != null ? `API Key #${g.apiKeyId}` : "未知 Key";
          return [
            label,
            g._count._all,
            (g._sum.promptTokens ?? 0) + (g._sum.outputTokens ?? 0),
            Number(g._sum.paidCredits ?? 0n),
          ];
        })
      )
    );
  }

  // 明细列表
  const records = await db.usageRecord.findMany({
    where: { userId: user.id, channel },
    orderBy: { createdAt: "desc" },
    take: EXPORT_LIMIT,
  });
  return csvResponse(
    `usage-${channel}-list-${stamp}.csv`,
    buildCsv(
      ["时间", "功能", "接口类型", "Key", "模型", "输入 tokens", "输出 tokens", "总 tokens", "扣积分", "状态"],
      records.map((r) => [
        csvTime(r.createdAt),
        FEATURE[r.endpointType] || r.endpointType,
        r.endpointType,
        channel === "apikey" ? (r.apiKeyId != null ? `API Key #${r.apiKeyId}` : "未知 Key") : "",
        r.modelSnapshot,
        r.promptTokens,
        r.outputTokens,
        r.promptTokens + r.outputTokens,
        Number(r.paidCredits),
        r.status,
      ])
    )
  );
}
