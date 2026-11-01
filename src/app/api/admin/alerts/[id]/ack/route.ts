import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// ─── P6 运营告警：确认告警（ackAt = now） ───
// POST /api/admin/alerts/:id/ack
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { user: admin, ok } = await requirePerm(PERMISSIONS.REPORT_READ);
  if (!admin || !ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const alertId = parseInt(id);
  if (!Number.isInteger(alertId) || alertId <= 0) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }
  const alert = await db.operationalAlert.findUnique({ where: { id: alertId } });
  if (!alert) return NextResponse.json({ error: "告警不存在" }, { status: 404 });
  if (alert.ackAt) return NextResponse.json({ ok: true, already: true });

  await db.operationalAlert.update({ where: { id: alertId }, data: { ackAt: new Date() } });
  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "operational_alert",
    targetId: alertId,
    detail: JSON.stringify({ section: "alerts_ack", alertType: alert.alertType }),
    ip: await getClientIp(),
  });
  return NextResponse.json({ ok: true });
}
