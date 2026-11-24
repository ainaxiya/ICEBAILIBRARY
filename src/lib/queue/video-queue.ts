// ─── P6 #20 BullMQ 视频任务队列 ───
// REDIS_URL 配置后启用：POST /v1/videos 创建任务 → 入队 → 任意实例的 Worker 消费
// （BullMQ 基于 Redis 分布式锁保证同一任务只被一个实例处理）；
// 未配置 REDIS_URL（本地开发 / E2E）自动回退进程内 inline 执行，零配置可跑。
// 入队失败（Redis 抖动）也回退 inline，任务绝不滞留。

import { Queue, Worker, type Job } from "bullmq";
import IORedis, { type RedisOptions } from "ioredis";
import type { ModelPricing } from "@prisma/client";
import { runVideoTask, unitsForTask } from "@/lib/gateway/video-task";
import { loadKeyCandidatesByIds } from "@/lib/gateway/router";
import type { UsageInput } from "@/lib/gateway/usage";

export const VIDEO_QUEUE_NAME = "icebai-video-tasks";
// 实验场视频任务也走这一条视频线（与网关视频共用并发槽，避免两条线各开一份）
export const PLAYGROUND_VIDEO_JOB = "playground-video";

// 任务载荷（POST 时定格，全部可 JSON 序列化；定价 Decimal 按字符串搬运，toNum 可解析）
// 安全口径：只传 vendorKeyId，不传解密后的 apiKey —— Redis 里不留上游账号明文，
// Worker 消费时再按 id 从库中解密（loadKeyCandidatesByIds）。
export interface VideoQueueJobData {
  taskId: string;
  vendorKeyIds: number[];
  body: Record<string, unknown>;
  baseUsage: Omit<UsageInput, "status" | "costMilli" | "paidCredits" | "vendorKeyId">;
  // ModelPricing 的可序列化快照（Decimal→string / BigInt→string）
  pricing: Record<string, string | number | null>;
  durationSec: number;
  started: number;
}

export function queueEnabled(): boolean {
  return !!process.env.REDIS_URL;
}

// 入队短连接配置（media-queue 复用同一口径）
// 安全护栏：队列载荷里绝不允许出现上游明文密钥字段。
// 历史事故：旧版本把 candidates[].apiKey 写进 job.data，明文落进 Redis/RDB。
// 现口径是只传 vendorKeyIds，Worker 消费时按 id 从库中解密；这里兜底防回归。
const SECRET_FIELD_RE = /^(api_?key|access_?key|secret_?key|authorization)$/i;
function assertNoSecretFields(data: unknown, path = "data"): void {
  if (data == null || typeof data !== "object") return;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (SECRET_FIELD_RE.test(k) && typeof v === "string") {
      throw new Error(`队列载荷含敏感字段 ${path}.${k}，拒绝入队（只允许传 vendorKeyIds）`);
    }
    assertNoSecretFields(v, `${path}.${k}`);
  }
}

// 入队链路超时：Redis 不可用时必须在秒级失败并回退 inline，不能把请求挂住
const CONNECT_TIMEOUT_MS = Number(process.env.VIDEO_QUEUE_CONNECT_TIMEOUT_MS) || 5_000;
const COMMAND_TIMEOUT_MS = Number(process.env.VIDEO_QUEUE_TIMEOUT_MS) || 8_000;

// Worker 长连接：BullMQ 阻塞命令（BRPOPLPUSH 等）不能被 commandTimeout 打断，
// 因此 Worker 侧只设 connectTimeout / maxRetriesPerRequest:null，不设 commandTimeout。
export function redisOpts(): RedisOptions {
  return {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    connectTimeout: CONNECT_TIMEOUT_MS,
  };
}

// 入队短连接：带命令超时，连不上/命令卡住都会快速失败（由调用方回退 inline）
export function enqueueRedisOpts(): RedisOptions {
  return {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: false,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
    // 短连接是「新建即用」：必须允许离线排队，否则构造函数返回时握手尚未完成，
    // 首个命令会直接报 Stream isn't writeable（状态页/重启/入队全部误判失败）。
    // 仍然保证快速失败：连接超时 + 重试 3 次后 retryStrategy 返回 null，挂起命令被拒绝。
    enableOfflineQueue: true,
    retryStrategy: (times) => (times > 2 ? null : Math.min(times * 200, 1_000)),
  };
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// 入队参数（enqueue 与 reconciler 重投共用同一口径）
const VIDEO_JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 500 },
};

// 短连接执行一段队列操作（入队 / 查询 / 重投共用）
async function withShortQueue<T>(fn: (queue: Queue<VideoQueueJobData>) => Promise<T>): Promise<T> {
  const conn = new IORedis(process.env.REDIS_URL!, enqueueRedisOpts());
  conn.on("error", (e: Error) => {
    console.error("[video-queue] redis 连接异常:", e.message.slice(0, 200));
  });
  const queue = new Queue<VideoQueueJobData>(VIDEO_QUEUE_NAME, { connection: conn });
  try {
    return await fn(queue);
  } finally {
    await withTimeout(queue.close(), 2_000, "关闭队列").catch(() => {});
    conn.disconnect();
  }
}

// 入队：jobId = taskId（幂等去重）；失败返回 ok:false 由调用方回退 inline
export async function enqueueVideoTask(data: VideoQueueJobData): Promise<{ ok: boolean; error?: string }> {
  try {
    assertNoSecretFields(data);
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
  try {
    await withShortQueue((queue) =>
      withTimeout(queue.add("video-task", data, { jobId: data.taskId, ...VIDEO_JOB_OPTS }), COMMAND_TIMEOUT_MS, "BullMQ 入队")
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}

// reconciler 重投：Redis 里没有该 job（或 job 已在 completed/failed 等终态）时补投。
// 仍在 wait/active/delayed 的 job 不动（BullMQ 自己会重试 stalled 任务）。
export async function ensureVideoJob(
  data: VideoQueueJobData
): Promise<{ ok: boolean; action: "added" | "exists" | "replaced" | "error"; error?: string }> {
  try {
    assertNoSecretFields(data);
    const action = await withShortQueue(async (queue) => {
      const existing = await withTimeout(queue.getJob(data.taskId), COMMAND_TIMEOUT_MS, "查询队列任务");
      if (existing) {
        const state = await withTimeout(existing.getState(), COMMAND_TIMEOUT_MS, "查询任务状态");
        const alive = ["wait", "active", "delayed", "prioritized", "waiting-children"].includes(state);
        if (alive) return "exists" as const;
        await withTimeout(existing.remove(), COMMAND_TIMEOUT_MS, "移除终态任务");
        await withTimeout(
          queue.add("video-task", data, { jobId: data.taskId, ...VIDEO_JOB_OPTS }),
          COMMAND_TIMEOUT_MS,
          "BullMQ 重投"
        );
        return "replaced" as const;
      }
      await withTimeout(
        queue.add("video-task", data, { jobId: data.taskId, ...VIDEO_JOB_OPTS }),
        COMMAND_TIMEOUT_MS,
        "BullMQ 重投"
      );
      return "added" as const;
    });
    return { ok: true, action };
  } catch (e) {
    return { ok: false, action: "error", error: (e as Error).message.slice(0, 200) };
  }
}

// 收口时清掉队列里的 job，避免已判定失败的任务再被消费
export async function removeVideoJob(taskId: string): Promise<boolean> {
  try {
    return await withShortQueue(async (queue) => {
      const job = await withTimeout(queue.getJob(taskId), COMMAND_TIMEOUT_MS, "查询队列任务");
      if (!job) return false;
      await withTimeout(job.remove(), COMMAND_TIMEOUT_MS, "移除队列任务");
      return true;
    });
  } catch {
    return false;
  }
}

// Worker 处理器：按 keyId 复原候选（队列内不存明文 Key）→ 复用进程内执行器
// （原子抢占 + 计费/转存/退款闭环）
// 同一个视频队列还承载实验场视频任务（job.name=playground-video），二者共用一条视频线。
async function processVideoTask(job: Job<VideoQueueJobData | { taskId: string }>): Promise<void> {
  if (job.name === PLAYGROUND_VIDEO_JOB) {
    const { runMediaTask } = await import("@/lib/playground/media-task-runner");
    await runMediaTask((job.data as { taskId: string }).taskId);
    return;
  }
  const d = job.data as VideoQueueJobData;
  const pricing = d.pricing as unknown as ModelPricing;
  // 旧格式载荷没有 vendorKeyIds：按空候选处理，执行器会失败并全额退款，任务不滞留
  const vendorKeyIds = Array.isArray(d.vendorKeyIds) ? d.vendorKeyIds : [];
  const candidates = await loadKeyCandidatesByIds(vendorKeyIds);
  if (candidates.length === 0) {
    console.warn(`[video-worker] job ${job.id} 无可用 Key（vendorKeyIds=${vendorKeyIds.join(",") || "空"}），按失败退款收口`);
  }
  await runVideoTask({
    taskId: d.taskId,
    candidates,
    body: d.body,
    baseUsage: d.baseUsage,
    pricing,
    unitsFor: (count) => unitsForTask(pricing, count, d.durationSec),
    started: d.started,
    slotRelease: () => {}, // 并发槽在队列模式下由 DB 在飞任务数控制（跨实例），无内存槽可还
  });
}

let videoWorker: Worker<VideoQueueJobData | { taskId: string }> | null = null;

// 启动 Worker（幂等；REDIS_URL 未配置则不启动，保持 inline 模式）
// 并发来自后台设置 queue_config.video（DB），不再读代码常量。
export async function startVideoWorker(concurrency: number): Promise<Worker<VideoQueueJobData | { taskId: string }> | null> {
  if (!queueEnabled() || videoWorker) return videoWorker;
  videoWorker = new Worker<VideoQueueJobData | { taskId: string }>(VIDEO_QUEUE_NAME, processVideoTask, {
    connection: new IORedis(process.env.REDIS_URL!, redisOpts()),
    concurrency: Math.max(1, Math.floor(concurrency)),
    lockDuration: 120_000, // 长任务（上游轮询可达数分钟）锁自动续期
    // 空队列时阻塞等待 30 秒再重新检查（默认 5 秒）；有新任务入队时阻塞命令立即返回，不影响取任务延迟
    drainDelay: 30,
  });
  videoWorker.on("error", (e) => {
    console.error("[video-worker] 任务处理异常:", e.message.slice(0, 200));
  });
  videoWorker.on("failed", (job, err) => {
    console.error(`[video-worker] job ${job?.id} 最终失败:`, err.message.slice(0, 200));
  });
  const host = process.env.REDIS_URL!.replace(/\/\/.*@/, "//***@");
  console.log(
    `[video-worker] BullMQ worker 已启动 queue=${VIDEO_QUEUE_NAME} redis=${host} concurrency=${videoWorker.concurrency}`
  );
  return videoWorker;
}

// 供 Worker 进程优雅重启：停止取新任务后等待在跑任务收尾
export function getVideoWorker() {
  return videoWorker;
}
