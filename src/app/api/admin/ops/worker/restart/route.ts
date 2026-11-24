import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import IORedis from "ioredis";
import { requireAdmin } from "@/lib/auth";
import { logAdminAction, getClientIp, PERMISSIONS, requirePerm } from "@/lib/rbac";
import { getQueueStatusSnapshot } from "@/lib/ops/queue-status";
import { enqueueRedisOpts } from "@/lib/queue/video-queue";
import { WORKER_CONTROL_CHANNEL } from "@/lib/ops/heartbeat";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  // 审计要求写明「什么原因」；给运营看的短句即可
  reason: z.string().trim().min(2, "请填写重启原因").max(200, "重启原因过长"),
});

// ─── P6 #22 超管：优雅重启消费进程 ───
// 只重启 Worker（pm2 自动拉起），不重启 web、不动数据库。
// 前置：心跳在线且队列 inflight=0；否则一律拒绝（按钮在 UI 上同步置灰）。
// 实现：向 Redis 控制通道发布消息，Worker 收到后停止取新任务、等在跑任务收尾再退出；
//       web 不拼 shell、不跨用户发信号，避免命令注入。
export async function POST(req: NextRequest) {
  // 高危操作：仅超管，权限收紧
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!admin.isSuper) return NextResponse.json({ error: "仅超级管理员可重启消费进程" }, { status: 403 });
  const perm = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!perm.ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }

  if (!process.env.REDIS_URL) {
    return NextResponse.json({ error: "未配置 REDIS_URL，无法控制消费进程" }, { status: 503 });
  }

  const snapshot = await getQueueStatusSnapshot();
  if (!snapshot.redisOk) {
    return NextResponse.json({ error: "Redis 不可用，无法确认队列状态" }, { status: 503 });
  }
  if (!snapshot.worker.online) {
    return NextResponse.json({ error: "消费进程心跳已过期，请先检查 pm2 状态" }, { status: 409 });
  }
  if (snapshot.workerInflight > 0) {
    return NextResponse.json(
      { error: `还有 ${snapshot.workerInflight} 个任务在跑，暂不能重启`, inflight: snapshot.workerInflight },
      { status: 409 }
    );
  }

  const requestedAt = Date.now();
  const conn = new IORedis(process.env.REDIS_URL, enqueueRedisOpts());
  conn.on("error", () => {});
  let receivers = 0;
  try {
    receivers = await conn.publish(
      WORKER_CONTROL_CHANNEL,
      JSON.stringify({
        action: "restart",
        requestedAt,
        by: admin.id,
        reason: parsed.data.reason,
      })
    );
  } catch (e) {
    return NextResponse.json({ error: `控制消息发送失败：${(e as Error).message.slice(0, 120)}` }, { status: 503 });
  } finally {
    conn.disconnect();
  }
  if (receivers === 0) {
    return NextResponse.json({ error: "消费进程未响应控制通道（心跳可能已过期）" }, { status: 503 });
  }

  await logAdminAction({
    adminId: admin.id,
    action: "restart_worker",
    targetType: "worker",
    detail: JSON.stringify({
      reason: parsed.data.reason,
      requestedAt,
      inflight: snapshot.workerInflight,
      workerPid: snapshot.worker.pid,
      workerStartedAt: snapshot.worker.startedAt,
    }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, requestedAt });
}
