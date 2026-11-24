import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { num } from "@/lib/model-json";
import { PERMISSIONS, requirePerm } from "@/lib/rbac";
import { shanghaiDayRange, summarizePlaygroundStats } from "@/lib/playground/stats";

export const dynamic = "force-dynamic";

// ─── pa33 实验场运行看板 ───
// GET /api/admin/playground/stats
// 今日（Asia/Shanghai 自然日）实验场（channel = onsite）调用量 / 成功率 / 平均耗时 / 热门模型。
// 只读聚合 usage_record，不写库、不改口径、不新增表或列。
export async function GET() {
  const { ok } = await requirePerm(PERMISSIONS.SETTING_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { start, end, day } = shanghaiDayRange();

  type SummaryRow = Record<string, unknown>;
  type ModelRow = Record<string, unknown>;

  const [summaryRows, modelRows] = await Promise.all([
    db.$queryRaw<SummaryRow[]>`
      SELECT
        COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE status = 'success')::int AS success_calls,
        AVG("latencyMs") AS avg_latency_ms
      FROM usage_record
      WHERE channel = 'onsite' AND "createdAt" >= ${start} AND "createdAt" < ${end}
    `,
    db.$queryRaw<ModelRow[]>`
      SELECT
        "modelSnapshot" AS model,
        COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE status = 'success')::int AS success
      FROM usage_record
      WHERE channel = 'onsite' AND "createdAt" >= ${start} AND "createdAt" < ${end}
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT 10
    `,
  ]);

  const row = summaryRows[0] ?? {};
  const summary = summarizePlaygroundStats({
    calls: num(row.calls ?? 0),
    successCalls: num(row.success_calls ?? 0),
    avgLatencyMs: row.avg_latency_ms == null ? null : num(row.avg_latency_ms),
    models: modelRows.map((r) => ({
      model: r.model == null ? null : String(r.model),
      calls: num(r.calls ?? 0),
      success: num(r.success ?? 0),
    })),
  });

  return NextResponse.json({
    day,
    rangeStart: start.toISOString(),
    rangeEnd: end.toISOString(),
    ...summary,
  });
}
