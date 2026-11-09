import { NextRequest, NextResponse } from "next/server";
import { checkOperationalAlerts, getAlertsConfig } from "@/lib/alerts";

export const dynamic = "force-dynamic";

// ─── v0.92 #1 运营告警 cron 自动巡检入口 ───
// 服务器 crontab 每小时调用：GET /api/cron/alerts-check?token=<CRON_SECRET>
// 鉴权：query token 必须等于环境变量 CRON_SECRET（未配置则接口禁用，防误暴露）。
// 总开关（alerts_config.enabled）关闭时跳过巡检（后台手动「立即检查」不受影响）。
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "cron not configured" }, { status: 404 });
  if (req.nextUrl.searchParams.get("token") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const cfg = await getAlertsConfig();
  if (!cfg.enabled) return NextResponse.json({ ok: true, skipped: "alerts disabled" });
  const result = await checkOperationalAlerts();
  return NextResponse.json({ ok: true, created: result.created.length, alerts: result.created.map((a) => ({ id: a.id, type: a.alertType, level: a.level })) });
}
