import { NextResponse } from "next/server";
import { PERMISSIONS, requirePerm } from "@/lib/rbac";
import { getQueueStatusSnapshot } from "@/lib/ops/queue-status";

export const dynamic = "force-dynamic";

// P6 #22 消费线状态：并发配置 / 在跑 / 空闲 / 最后心跳 / 是否离线
// 与侧边栏状态灯共用同一份快照（getQueueStatusSnapshot）。
export async function GET() {
  const { admin, ok } = await requirePerm(PERMISSIONS.SETTING_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const snapshot = await getQueueStatusSnapshot();
  // canRestart：仅超管可见可点（服务端仍会在重启接口二次校验）
  return NextResponse.json({ ...snapshot, canRestart: !!admin?.isSuper });
}
