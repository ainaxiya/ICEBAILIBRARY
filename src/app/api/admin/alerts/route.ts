import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { checkOperationalAlerts, getAlertsConfig, saveAlertsConfig } from "@/lib/alerts";

export const dynamic = "force-dynamic";

// ─── P6 运营告警 API ───
// GET  /api/admin/alerts              告警列表 + 未确认数 + 阈值配置
// POST /api/admin/alerts              action: "check" 手动巡检 / "saveConfig" 保存阈值

// GET /api/admin/alerts?page=&ack=unacked|all
export async function GET(req: NextRequest) {
  const { ok } = await requirePerm(PERMISSIONS.REPORT_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") || "1") || 1);
  const pageSize = 20;
  const ackFilter = sp.get("ack") === "unacked" ? { ackAt: null } : {};

  const [total, unackCount, items, config] = await Promise.all([
    db.operationalAlert.count({ where: ackFilter }),
    db.operationalAlert.count({ where: { ackAt: null } }),
    db.operationalAlert.findMany({
      where: ackFilter,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    getAlertsConfig(),
  ]);

  return NextResponse.json({
    page,
    pageSize,
    total,
    unackCount,
    config,
    items: items.map((a) => ({
      id: a.id,
      alertType: a.alertType,
      level: a.level,
      message: a.message,
      payload: a.payload,
      ackAt: a.ackAt,
      createdAt: a.createdAt,
    })),
  });
}

const configSchema = z.object({
  creditPoolThreshold: z.coerce.number().min(0).max(1e12),
  marginRateThreshold: z.coerce.number().min(0).max(1),
  userBurst24hCredits: z.coerce.number().min(0).max(1e12),
});

// POST /api/admin/alerts
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const action = typeof body?.action === "string" ? body.action : "";
  const ip = await getClientIp();

  // ── 手动巡检（本地开发无 cron，后台「运营告警」页按钮触发） ──
  if (action === "check") {
    const { user: admin, ok } = await requirePerm(PERMISSIONS.REPORT_READ);
    if (!admin || !ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const result = await checkOperationalAlerts();
    await logAdminAction({
      adminId: admin.id,
      action: "create",
      targetType: "operational_alert",
      detail: JSON.stringify({ section: "alerts_check", created: result.created.length }),
      ip,
    });
    return NextResponse.json({ ok: true, ...result });
  }

  // ── 保存告警阈值配置（SiteSetting key="alerts_config"） ──
  if (action === "saveConfig") {
    const { user: admin, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
    if (!admin || !ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const parsed = configSchema.safeParse(body?.config ?? null);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
    }
    const config = await saveAlertsConfig(parsed.data);
    await logAdminAction({
      adminId: admin.id,
      action: "update",
      targetType: "setting",
      detail: JSON.stringify({ section: "alerts_config", config }),
      ip,
    });
    return NextResponse.json({ ok: true, config });
  }

  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}
