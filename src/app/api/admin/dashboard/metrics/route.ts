import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { PERMISSIONS, requirePerm } from "@/lib/rbac";
import { getDashboardMetrics } from "@/lib/dashboard-metrics";

export const dynamic = "force-dynamic";

// 后台仪表盘指标：单一接口刷新全部区块（页面 SSR 与 60s 轮询共用同一份聚合）
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { ok } = await requirePerm(PERMISSIONS.REPORT_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const metrics = await getDashboardMetrics();
  return NextResponse.json(metrics, {
    headers: { "Cache-Control": "no-store" },
  });
}
