// ─── P6 #22 独立消费进程入口 ───
// pm2 常驻（CompletePrompt-Worker），与 web 进程分离：
//   · 视频线（网关 /v1/videos + 实验场视频）：queue_config.video
//   · 图片线（实验场图片，独立通道）：queue_config.image
//   · 产物下载线（独立队列）：queue_config.download
// 空闲时 BullMQ Worker 阻塞在 Redis 的阻塞命令上，不轮询空转；
// 另有一个 60 秒对账扫描（DB↔队列一致性）与 15 秒心跳，这两者是低频定时器，不是队列轮询。
// 优雅重启：订阅 icebai:ops:worker-control，收指令后停止取新任务 → 等在跑任务收尾 → 退出，
// 由 pm2 自动拉起。web 只负责发布消息和审计，不拼 shell、不发跨用户信号。

import "dotenv/config";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { getQueueConfig } from "@/lib/queue/queue-config";
import { redisOpts, startVideoWorker, getVideoWorker, VIDEO_QUEUE_NAME } from "@/lib/queue/video-queue";
import {
  startPlaygroundImageWorker,
  getPlaygroundImageWorker,
  PLAYGROUND_IMAGE_QUEUE_NAME,
} from "@/lib/queue/media-queue";
import { startAssetWorker, getAssetWorker, ASSET_QUEUE_NAME } from "@/lib/queue/asset-queue";
import { startQueueReconciler } from "@/lib/queue/reconciler";
import { recoverStaleTasks } from "@/lib/playground/media-task-runner";
import {
  WORKER_HEARTBEAT_KEY,
  WORKER_CONTROL_CHANNEL,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TTL_SEC,
  type WorkerControlMessage,
} from "@/lib/ops/heartbeat";

const STARTED_AT = Date.now();
let shuttingDown = false;

async function main() {
  if (!process.env.REDIS_URL) {
    console.error("[worker] 缺少 REDIS_URL，消费进程无法启动");
    process.exit(1);
  }

  const cfg = await getQueueConfig();
  await startVideoWorker(cfg.video);
  await startPlaygroundImageWorker(cfg.image);
  await startAssetWorker(cfg.download);
  startQueueReconciler();

  // 实验场媒体任务巡检（租约过期接管 / queued 补投），与网关视频对账分开
  const runRecover = () => {
    void recoverStaleTasks().catch((e) =>
      console.error("[worker] 实验场任务巡检失败:", (e as Error).message.slice(0, 200))
    );
  };
  await runRecover();
  const recoverTimer = setInterval(runRecover, 60_000);
  recoverTimer.unref();

  // ── 心跳 + 在跑任务数（供运维页 / 重启前置条件使用）──
  const hbConn = new IORedis(process.env.REDIS_URL, redisOpts());
  hbConn.on("error", () => {});
  const queues = [VIDEO_QUEUE_NAME, PLAYGROUND_IMAGE_QUEUE_NAME, ASSET_QUEUE_NAME].map(
    (name) => new Queue(name, { connection: hbConn })
  );
  const writeHeartbeat = async () => {
    let inflight = 0;
    try {
      const counts = await Promise.all(queues.map((q) => q.getActiveCount()));
      inflight = counts.reduce((a, b) => a + b, 0);
    } catch {
      // Redis 抖动时不阻断心跳
    }
    const payload = {
      ts: Date.now(),
      pid: process.pid,
      startedAt: STARTED_AT,
      hostname: process.env.HOSTNAME || "",
      inflight,
    };
    await hbConn.set(WORKER_HEARTBEAT_KEY, JSON.stringify(payload), "EX", HEARTBEAT_TTL_SEC).catch(() => {});
  };
  await writeHeartbeat();
  const hbTimer = setInterval(() => void writeHeartbeat(), HEARTBEAT_INTERVAL_MS);
  hbTimer.unref();

  // ── 优雅重启控制通道 ──
  const sub = new IORedis(process.env.REDIS_URL, redisOpts());
  sub.on("error", () => {});
  await sub.subscribe(WORKER_CONTROL_CHANNEL);
  sub.on("message", (_channel: string, raw: string) => {
    try {
      const msg = JSON.parse(raw) as WorkerControlMessage;
      if (msg.action === "restart") {
        void shutdown(`控制通道重启 by=${msg.by} reason=${msg.reason}`);
      }
    } catch {
      // 忽略无法解析的控制消息
    }
  });

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] 开始优雅退出：${reason}`);
    clearInterval(hbTimer);
    clearInterval(recoverTimer);
    const workers = [getVideoWorker(), getPlaygroundImageWorker(), getAssetWorker()].filter(
      (w): w is NonNullable<typeof w> => !!w
    );
    // 先停止取新任务，再等在跑任务收尾（视频可能跑几分钟，这是预期行为）
    await Promise.all(workers.map((w) => w.pause().catch(() => {})));
    await Promise.all(workers.map((w) => w.close().catch(() => {})));
    await Promise.all(queues.map((q) => q.close().catch(() => {})));
    await sub.quit().catch(() => {});
    hbConn.disconnect();
    console.log("[worker] 已退出，等待 pm2 拉起");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  console.log(
    `[worker] ready pid=${process.pid} concurrency video=${cfg.video} image=${cfg.image} download=${cfg.download}`
  );
}

void main().catch((e) => {
  console.error("[worker] 启动失败:", e);
  process.exit(1);
});
