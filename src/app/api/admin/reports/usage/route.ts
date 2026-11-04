import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm } from "@/lib/rbac";
import { num } from "@/lib/model-json";

export const dynamic = "force-dynamic";

// ─── P3 消费报表（毛利报表） ───
// GET /api/admin/reports/usage?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&modelId=&groupBy=day|model
// 聚合 usage_record：调用数/tokens/用户扣分/内部成本/毛利/成功率/平均延迟
// 毛利（毫积分） = Σpaid_credits×1000 − Σcost_milli
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.REPORT_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const groupBy = sp.get("groupBy") === "model" ? "model" : "day";
  const dateFrom = sp.get("dateFrom") || "";
  const dateTo = sp.get("dateTo") || "";
  if ((dateFrom && !DATE_RE.test(dateFrom)) || (dateTo && !DATE_RE.test(dateTo))) {
    return NextResponse.json({ error: "日期格式应为 YYYY-MM-DD" }, { status: 400 });
  }

  // 默认近 30 天；dateTo 含当天（< 次日 0 点）
  const to = dateTo ? new Date(`${dateTo}T00:00:00.000Z`) : new Date();
  const toEnd = new Date(to.getTime() + 24 * 3600 * 1000);
  const from = dateFrom
    ? new Date(`${dateFrom}T00:00:00.000Z`)
    : new Date(toEnd.getTime() - 30 * 24 * 3600 * 1000);

  const modelId = Number(sp.get("modelId") || 0);
  const modelFilter = modelId ? Prisma.sql`AND "modelId" = ${BigInt(modelId)}` : Prisma.empty;

  // 渠道过滤：all（默认，不过滤）| onsite | apikey
  const channelRaw = sp.get("channel") || "all";
  const channel = channelRaw === "onsite" || channelRaw === "apikey" ? channelRaw : "all";
  const channelFilter = channel === "all" ? Prisma.empty : Prisma.sql`AND channel = ${channel}`;

  type RawRow = Record<string, unknown>;

  let rows: RawRow[];
  if (groupBy === "day") {
    rows = await db.$queryRaw<RawRow[]>`
      SELECT
        to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS bucket,
        COUNT(*)::int AS calls,
        COALESCE(SUM("promptTokens"), 0)::bigint AS prompt_tokens,
        COALESCE(SUM("outputTokens"), 0)::bigint AS output_tokens,
        COALESCE(SUM("paidCredits"), 0)::bigint AS paid_credits,
        COALESCE(SUM("costMilli"), 0)::bigint AS cost_milli,
        COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
        AVG("latencyMs") AS avg_latency_ms
      FROM usage_record
      WHERE "createdAt" >= ${from} AND "createdAt" < ${toEnd} ${modelFilter} ${channelFilter}
      GROUP BY 1
      ORDER BY 1
    `;
  } else {
    rows = await db.$queryRaw<RawRow[]>`
      SELECT
        COALESCE("modelId", 0)::text AS bucket,
        MAX("modelSnapshot") AS model_name,
        COUNT(*)::int AS calls,
        COALESCE(SUM("promptTokens"), 0)::bigint AS prompt_tokens,
        COALESCE(SUM("outputTokens"), 0)::bigint AS output_tokens,
        COALESCE(SUM("paidCredits"), 0)::bigint AS paid_credits,
        COALESCE(SUM("costMilli"), 0)::bigint AS cost_milli,
        COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
        AVG("latencyMs") AS avg_latency_ms
      FROM usage_record
      WHERE "createdAt" >= ${from} AND "createdAt" < ${toEnd} ${modelFilter} ${channelFilter}
      GROUP BY 1
      ORDER BY 6 DESC
    `;
  }

  const items = rows.map((r) => {
    const calls = num(r.calls);
    const successCount = num(r.success_count);
    const promptTokens = num(r.prompt_tokens);
    const outputTokens = num(r.output_tokens);
    const paidCredits = num(r.paid_credits);
    const costMilli = num(r.cost_milli);
    const revenueMilli = paidCredits * 1000;
    const profitMilli = revenueMilli - costMilli;
    return {
      bucket: String(r.bucket),
      date: groupBy === "day" ? String(r.bucket) : null,
      modelId: groupBy === "model" ? (String(r.bucket) === "0" ? null : Number(r.bucket)) : null,
      modelName: groupBy === "model" ? String(r.model_name ?? "") : null,
      calls,
      promptTokens,
      outputTokens,
      totalTokens: promptTokens + outputTokens,
      paidCredits,
      costMilli,
      revenueMilli,
      profitMilli,
      profitRate: revenueMilli > 0 ? profitMilli / revenueMilli : 0,
      successRate: calls > 0 ? successCount / calls : 0,
      avgLatencyMs: r.avg_latency_ms === null || r.avg_latency_ms === undefined ? null : Math.round(num(r.avg_latency_ms)),
    };
  });

  const totals = items.reduce(
    (s, it) => ({
      calls: s.calls + it.calls,
      promptTokens: s.promptTokens + it.promptTokens,
      outputTokens: s.outputTokens + it.outputTokens,
      paidCredits: s.paidCredits + it.paidCredits,
      costMilli: s.costMilli + it.costMilli,
    }),
    { calls: 0, promptTokens: 0, outputTokens: 0, paidCredits: 0, costMilli: 0 }
  );
  const revenueMilli = totals.paidCredits * 1000;

  return NextResponse.json({
    groupBy,
    channel,
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: new Date(toEnd.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10),
    items,
    totals: {
      ...totals,
      totalTokens: totals.promptTokens + totals.outputTokens,
      revenueMilli,
      profitMilli: revenueMilli - totals.costMilli,
      profitRate: revenueMilli > 0 ? (revenueMilli - totals.costMilli) / revenueMilli : 0,
    },
  });
}
