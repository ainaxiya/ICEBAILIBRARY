// ─── P6 #23 消费进程心跳与重启控制 ───
// Worker 每 15 秒写一次心跳（TTL 90 秒）：
//   icebai:ops:heartbeat:worker  { ts, pid, startedAt, hostname, inflight }
// 运维页/侧边栏状态灯以「心跳是否存在」判断消费进程是否在线；
// 心跳过期 = 进程假死/退出，无需额外探活请求。
// 优雅重启：web 向 icebai:ops:worker-control 发布控制消息，Worker 停止取新任务、
// 等在跑任务收尾后退出，由 pm2 自动拉起。不使用拼接 shell，也不依赖跨用户发信号。
import IORedis from "ioredis";

export const WORKER_HEARTBEAT_KEY = "icebai:ops:heartbeat:worker";
export const WEB_HEARTBEAT_KEY = "icebai:ops:heartbeat:web";
export const WORKER_CONTROL_CHANNEL = "icebai:ops:worker-control";
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TTL_SEC = 90;

export interface HeartbeatPayload {
  ts: number;
  pid: number;
  startedAt: number;
  hostname: string;
  inflight?: number;
}

export interface WorkerControlMessage {
  action: "restart";
  requestedAt: number;
  by: number | string;
  reason: string;
}

export function parseHeartbeat(raw: string | null): HeartbeatPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<HeartbeatPayload>;
    if (typeof p.ts !== "number") return null;
    return {
      ts: p.ts,
      pid: Number(p.pid) || 0,
      startedAt: Number(p.startedAt) || p.ts,
      hostname: typeof p.hostname === "string" ? p.hostname : "",
      inflight: typeof p.inflight === "number" ? p.inflight : undefined,
    };
  } catch {
    return null;
  }
}

// web 侧心跳：状态页/健康检查被访问时确保存在一个 15 秒写入器（只启动一次）
const BOOT_AT = Date.now();
let webHbStarted = false;
let webHbConn: IORedis | null = null;

export function ensureWebHeartbeat(): void {
  if (webHbStarted || !process.env.REDIS_URL) return;
  webHbStarted = true;
  const conn = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    connectTimeout: 3_000,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 500, 2_000)),
  });
  webHbConn = conn;
  conn.on("error", () => {});
  const write = () => {
    void conn
      .set(
        WEB_HEARTBEAT_KEY,
        JSON.stringify({ ts: Date.now(), pid: process.pid, startedAt: BOOT_AT, hostname: process.env.HOSTNAME || "" }),
        "EX",
        HEARTBEAT_TTL_SEC
      )
      .catch(() => {});
  };
  write();
  const timer = setInterval(write, HEARTBEAT_INTERVAL_MS);
  timer.unref();
}

export function stopWebHeartbeat(): void {
  webHbConn?.disconnect();
  webHbConn = null;
  webHbStarted = false;
}
