import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { getPlaygroundMaintenance, setPlaygroundMaintenance } from "@/lib/ops/maintenance";

export const dynamic = "force-dynamic";

export async function GET() {
  const { ok } = await requirePerm(PERMISSIONS.SETTING_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json(await getPlaygroundMaintenance());
}

const bodySchema = z.object({
  enabled: z.boolean(),
  message: z.string().trim().max(200).optional(),
});

// P6 #22 实验场维护开关：开启后只停止接新任务；已在跑的任务不受影响
export async function PUT(req: NextRequest) {
  const { user: admin, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!admin || !ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }

  const state = await setPlaygroundMaintenance(parsed.data);
  await logAdminAction({
    adminId: admin.id,
    action: state.enabled ? "playground_maintenance_on" : "playground_maintenance_off",
    targetType: "setting",
    detail: JSON.stringify({ enabled: state.enabled, message: state.message }),
    ip: await getClientIp(),
  });
  return NextResponse.json({ ok: true, ...state });
}
