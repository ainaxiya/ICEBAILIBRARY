import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// ─── P6 运营告警批量操作：批量确认 / 批量删除 ───
// POST /api/admin/alerts/batch
// { action: "ack"|"delete", ids: number[] }

const schema = z.object({
  action: z.enum(["ack", "delete"]),
  ids: z.array(z.number().int().positive()).min(1).max(200),
});

// POST /api/admin/alerts/batch —— ack=批量确认（ackAt=now）/ delete=批量删除，返回 affected 数量
export async function POST(req: NextRequest) {
  const { user: admin, ok } = await requirePerm(PERMISSIONS.REPORT_READ);
  if (!admin || !ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { action, ids } = parsed.data;

  let affected = 0;
  if (action === "ack") {
    // 批量确认：仅未确认的告警置 ackAt=now，已确认的保持原确认时间
    affected = (
      await db.operationalAlert.updateMany({
        where: { id: { in: ids }, ackAt: null },
        data: { ackAt: new Date() },
      })
    ).count;
  } else {
    affected = (await db.operationalAlert.deleteMany({ where: { id: { in: ids } } })).count;
  }

  await logAdminAction({
    adminId: admin.id,
    action: action === "delete" ? "delete" : "update",
    targetType: "operational_alert",
    detail: JSON.stringify({ section: "alerts_batch", op: action, ids, affected }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, affected });
}
