// ─── P6 #22 消费线状态快照（运维页 / 侧边栏状态灯共用）──
// 数据来源：
//   · 在跑数：BullMQ 队列 active（worker 线）+ 进程内闸门 active（音频/文本）
//   · 心跳：Worker 每 15 秒写、90 秒过期；web 心跳在首次访问运维接口时启动
// 不额外造轮询：状态页在打开期间低频刷新，接口本身只做只读计数。

import { Queue } from "bullmq";
import IORedis from "ioredis";
import { enqueueRedisOpts } from "@/lib/queue/video-queue";
import { VIDEO_QUEUE_NAME } from "@/lib/queue/video-queue";
import { PLAYGROUND_IMAGE_QUEUE_NAME } from "@/lib/queue/media-queue";
import { ASSET_QUEUE_NAME } from "@/lib/queue/asset-queue";
import { getQueueConfig, QUEUE_CHANNEL_META } from "@/lib/queue/queue-config";
import { channelActive, channelWaiting } from "@/lib/queue/channel-gate";
import { getPlaygroundMaintenance, type MaintenanceState } from "@/lib/ops/maintenance";
import {
  WORKER_HEARTBEAT_KEY,
  WEB_HEARTBEAT_KEY,
  parseHeartbeat,
  ensureWebHeartbeat,
  type HeartbeatPayload,
} from "@/lib/ops/heartbeat";

export type StatusChannelKey = "video" | "audio" | "image" | "text" | "download";

export interface ChannelStatusRow {
  key: StatusChannelKey;
  label: string;
  scope: "worker" | "web";
  concurrency: number;
  running: number;
  idle: number;
  waiting: number;
  lastHeartbeatAt: number | null;
  online: boolean;
}

export interface QueueStatusSnapshot {
  now: number;
  redisOk: boolean;
  worker: {
    online: boolean;
    lastSeenAt: number | null;
    pid: number | null;
    startedAt: number | null;
    uptimeSec: number | null;
    reportedInflight: number | null;
  };
  web: {
    lastSeenAt: number | null;
  };
  channels: ChannelStatusRow[];
  // 仅 worker 队列在跑数（重启前置条件）
  workerInflight: number;
  maintenance: MaintenanceState;
}

const QUEUE_CHANNELS: { key: StatusChannelKey; queue: string }[] = [
  { key: "video", queue: VIDEO_QUEUE_NAME },
  { key: "image", queue: PLAYGROUND_IMAGE_QUEUE_NAME },
  { key: "download", queue: ASSET_QUEUE_NAME },
];

async function withRedis<T>(fn: (conn: IORedis) => Promise<T>): Promise<T> {
  const conn = new IORedis(process.env.REDIS_URL!, enqueueRedisOpts());
  conn.on("error", () => {});
  try {
    return await fn(conn);
  } finally {
    conn.disconnect();
  }
}

export async function getQueueStatusSnapshot(): Promise<QueueStatusSnapshot> {
  ensureWebHeartbeat();
  const now = Date.now();
  const cfg = await getQueueConfig();
  const maintenance = await getPlaygroundMaintenance();

  let redisOk = false;
  const queueCounts: Record<string, { running: number; waiting: number }> = {};
  let workerHb: HeartbeatPayload | null = null;
  let webHb: HeartbeatPayload | null = null;

  if (process.env.REDIS_URL) {
    try {
      const result = await withRedis(async (conn) => {
        const queues = QUEUE_CHANNELS.map(
          (c) => [c.key, new Queue(c.queue, { connection: conn })] as const
        );
        try {
          const [counts, workerRaw, webRaw] = await Promise.all([
            Promise.all(
              queues.map(async ([key, q]) => {
                const [running, waiting] = await Promise.all([q.getActiveCount(), q.getWaitingCount()]);
                return [key, { running, waiting }] as const;
              })
            ),
            conn.get(WORKER_HEARTBEAT_KEY),
            conn.get(WEB_HEARTBEAT_KEY),
          ]);
          return { counts, workerRaw, webRaw };
        } finally {
          await Promise.all(queues.map(([, q]) => q.close().catch(() => {})));
        }
      });
      redisOk = true;
      for (const [key, v] of result.counts) queueCounts[key] = v;
      workerHb = parseHeartbeat(result.workerRaw);
      webHb = parseHeartbeat(result.webRaw);
    } catch {
      redisOk = false;
    }
  }

  const workerOnline = !!workerHb && now - workerHb.ts < 90_000;
  const gate = {
    audio: { running: channelActive("audio"), waiting: channelWaiting("audio") },
    text: { running: channelActive("text"), waiting: channelWaiting("text") },
  };

  const metaByKey = new Map(QUEUE_CHANNEL_META.map((m) => [m.key, m]));
  const channels: ChannelStatusRow[] = [];
  for (const meta of QUEUE_CHANNEL_META) {
    const key = meta.key;
    if (key === "audio" || key === "text") {
      const g = gate[key];
      channels.push({
        key,
        label: meta.label,
        scope: "web",
        concurrency: cfg[key],
        running: g.running,
        idle: Math.max(0, cfg[key] - g.running),
        waiting: g.waiting,
        lastHeartbeatAt: webHb?.ts ?? now,
        online: true, // 能返回本页即说明 web 进程在线
      });
      continue;
    }
    const counts = queueCounts[key] ?? { running: 0, waiting: 0 };
    channels.push({
      key,
      label: metaByKey.get(key)?.label ?? key,
      scope: "worker",
      concurrency: cfg[key],
      running: counts.running,
      idle: Math.max(0, cfg[key] - counts.running),
      waiting: counts.waiting,
      lastHeartbeatAt: workerHb?.ts ?? null,
      online: redisOk && workerOnline,
    });
  }

  const workerInflight = channels
    .filter((c) => c.scope === "worker")
    .reduce((sum, c) => sum + c.running, 0);

  return {
    now,
    redisOk,
    worker: {
      online: workerOnline,
      lastSeenAt: workerHb?.ts ?? null,
      pid: workerHb?.pid ?? null,
      startedAt: workerHb?.startedAt ?? null,
      uptimeSec: workerHb?.startedAt ? Math.max(0, Math.round((now - workerHb.startedAt) / 1000)) : null,
      reportedInflight: workerHb?.inflight ?? null,
    },
    web: { lastSeenAt: webHb?.ts ?? now },
    channels,
    workerInflight,
    maintenance,
  };
}
