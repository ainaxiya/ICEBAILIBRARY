// ─── P6 #22 实验场媒体任务队列（图片独立通道 / 视频并入视频线）──
// 图片：上游同步接口，一次 1–2 分钟 —— 必须独占一条通道，不能和状态轮询共用；
// 视频：提交后靠轮询，并入网关视频队列（icebai-video-tasks），与网关视频共用一条线，
//       避免两条线各开一份并发、各占一个槽。
// 两类任务都用 jobId 幂等去重，重复入队不会产生第二个 job。

import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import {
  VIDEO_QUEUE_NAME,
  PLAYGROUND_VIDEO_JOB,
  enqueueRedisOpts,
  redisOpts,
  queueEnabled,
  withTimeout,
} from "./video-queue";

export const PLAYGROUND_IMAGE_QUEUE_NAME = "icebai-playground-image";
export const PLAYGROUND_IMAGE_JOB = "playground-image";

const COMMAND_TIMEOUT_MS = Number(process.env.VIDEO_QUEUE_TIMEOUT_MS) || 8_000;

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 500 },
};

async function withShortQueue<T>(name: string, fn: (queue: Queue) => Promise<T>): Promise<T> {
  const conn = new IORedis(process.env.REDIS_URL!, enqueueRedisOpts());
  conn.on("error", (e: Error) => {
    console.error(`[media-queue] redis 连接异常(${name}):`, e.message.slice(0, 200));
  });
  const queue = new Queue(name, { connection: conn });
  try {
    return await fn(queue);
  } finally {
    await withTimeout(queue.close(), 2_000, "关闭队列").catch(() => {});
    conn.disconnect();
  }
}

// 入队：image → 图片独立队列；video → 网关视频队列（job.name 区分）
// 失败返回 ok:false，由调用方回退进程内执行，任务不滞留。
export async function enqueuePlaygroundMedia(
  kind: "image" | "video",
  taskId: string
): Promise<{ ok: boolean; error?: string }> {
  if (!queueEnabled()) return { ok: false, error: "REDIS_URL 未配置" };
  const queueName = kind === "image" ? PLAYGROUND_IMAGE_QUEUE_NAME : VIDEO_QUEUE_NAME;
  const jobName = kind === "image" ? PLAYGROUND_IMAGE_JOB : PLAYGROUND_VIDEO_JOB;
  const jobId = `${kind === "image" ? "pgi" : "pgv"}-${taskId}`;
  try {
    await withShortQueue(queueName, (queue) =>
      withTimeout(
        queue.add(jobName, { taskId }, { jobId, ...JOB_OPTS }),
        COMMAND_TIMEOUT_MS,
        "BullMQ 入队"
      )
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}

let imageWorker: Worker | null = null;

// 图片通道 Worker：并发来自后台设置 queue_config.image（Worker 启动时读取）
export async function startPlaygroundImageWorker(concurrency: number): Promise<Worker | null> {
  if (!queueEnabled() || imageWorker) return imageWorker;
  imageWorker = new Worker(
    PLAYGROUND_IMAGE_QUEUE_NAME,
    async (job) => {
      const { runMediaTask } = await import("@/lib/playground/media-task-runner");
      await runMediaTask((job.data as { taskId: string }).taskId);
    },
    {
      connection: new IORedis(process.env.REDIS_URL!, redisOpts()),
      concurrency: Math.max(1, Math.floor(concurrency)),
      // 同步图片可能跑十几分钟；BullMQ 会自动续锁，这里只给足初始时长
      lockDuration: 300_000,
      // 空队列时阻塞等待 30 秒再重新检查（默认 5 秒）；有新任务入队时阻塞命令立即返回
      drainDelay: 30,
    }
  );
  imageWorker.on("error", (e) => {
    console.error("[image-worker] 任务处理异常:", e.message.slice(0, 200));
  });
  imageWorker.on("failed", (job, err) => {
    console.error(`[image-worker] job ${job?.id} 最终失败:`, err.message.slice(0, 200));
  });
  console.log(
    `[image-worker] 已启动 queue=${PLAYGROUND_IMAGE_QUEUE_NAME} concurrency=${imageWorker.concurrency}`
  );
  return imageWorker;
}

export function getPlaygroundImageWorker() {
  return imageWorker;
}
