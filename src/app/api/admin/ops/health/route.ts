import { NextResponse } from "next/server";
import { PERMISSIONS, requirePerm } from "@/lib/rbac";
import { getQueueStatusSnapshot } from "@/lib/ops/queue-status";

export const dynamic = "force-dynamic";

// P6 #23 侧边栏状态灯数据源：worker 心跳 + 各消费线在线状态
export async function GET() {
  const { ok } = await requirePerm(PERMISSIONS.REPORT_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const s = await getQueueStatusSnapshot();
  const offline = s.channels.filter((c) => !c.online).map((c) => c.key);
  return NextResponse.json({
    ok: s.worker.online && offline.length === 0,
    workerOnline: s.worker.online,
    redisOk: s.redisOk,
    lastSeenAt: s.worker.lastSeenAt,
    inflight: s.workerInflight,
    offlineChannels: offline,
    maintenance: s.maintenance.enabled,
  });
}
