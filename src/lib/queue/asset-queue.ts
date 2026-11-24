// ─── P6 #21/#22 产物下载队列（独立异步通道）──
// 视频任务成功后，状态与结算已经落库；产物转存（下载 → 对象存储/本地盘）是大文件 IO，
// 拆到独立队列由独立消费者处理，不占用状态轮询那条线。
// 消费端：downloadVideoAsset —— 成功但没有 assetId 的补转存；转存失败（deleted 且留 sourceUrl）
// 的原地重试一次；失败抛错交给 BullMQ 按 5s/10s/20s 退避重试。
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { db } from "@/lib/db";
import { retryAssetTransfer, saveGeneratedAsset } from "@/lib/assets";
import { enqueueRedisOpts, redisOpts, withTimeout } from "./video-queue";

export const ASSET_QUEUE_NAME = "icebai-assets";

export interface AssetDownloadJobData {
  taskId: string;
  userId: number;
  requestId: string;
}

export function assetQueueEnabled(): boolean {
  return !!process.env.REDIS_URL;
}

const COMMAND_TIMEOUT_MS = Number(process.env.VIDEO_QUEUE_TIMEOUT_MS) || 8_000;

// jobId 固定为 asset-<taskId>：同一任务的补投天然幂等，不会在同一条线上重复下载
export async function enqueueAssetDownload(data: AssetDownloadJobData): Promise<{ ok: boolean; error?: string }> {
  if (!assetQueueEnabled()) return { ok: false, error: "未配置 REDIS_URL" };
  let conn: IORedis | null = null;
  let queue: Queue<AssetDownloadJobData> | null = null;
  try {
    conn = new IORedis(process.env.REDIS_URL!, enqueueRedisOpts());
    conn.on("error", (e: Error) => {
      console.error("[asset-queue] redis 连接异常:", e.message.slice(0, 200));
    });
    queue = new Queue<AssetDownloadJobData>(ASSET_QUEUE_NAME, { connection: conn });
    await withTimeout(
      queue.add("asset-download", data, {
        jobId: `asset-${data.taskId}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 1000 },
      }),
      COMMAND_TIMEOUT_MS,
      "BullMQ 产物下载入队"
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  } finally {
    if (queue) await withTimeout(queue.close(), 2_000, "关闭下载队列").catch(() => {});
    conn?.disconnect();
  }
}

function parseUrls(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

// 补转存：只处理「已成功、有产物 URL」的任务。
// 若任务已挂着一个 deleted 资产且留有 sourceUrl → 原地重试拉取（不重复建资产）；
// 否则重新走一次 saveGeneratedAsset 并把新 assetId 写回任务。
// 失败一律抛错，交给 BullMQ 退避重试（最多 3 次）；不可重试的情况直接返回 false。
export async function downloadVideoAsset(taskId: string): Promise<boolean> {
  const task = await db.videoTask.findUnique({ where: { taskId } });
  if (!task || task.status !== "succeeded") return false;
  const urls = parseUrls(task.resultUrls);
  if (urls.length === 0) return false;

  if (task.assetId != null) {
    const asset = await db.generatedAsset.findUnique({ where: { id: BigInt(task.assetId) } });
    if (!asset || asset.status !== "deleted") return false;
    if (!asset.sourceUrl) return false;
    const r = await retryAssetTransfer(asset.id, task.userId);
    if (!r.ok) throw new Error(r.error || "产物重试拉取失败");
    return true;
  }

  const usage = await db.usageRecord.findUnique({
    where: { requestId: task.requestId },
    select: { id: true },
  });
  const saved = await saveGeneratedAsset({
    userId: task.userId,
    usageRecordId: usage ? BigInt(usage.id) : null,
    assetType: "video",
    resultUrl: urls[0],
  });
  if (saved.assetId != null) {
    await db.videoTask.updateMany({
      where: { taskId, assetId: null },
      data: { assetId: Number(saved.assetId) },
    });
  }
  if (!saved.ok) throw new Error(saved.error || "产物转存失败");
  return true;
}

let assetWorker: Worker<AssetDownloadJobData> | null = null;

// 产物下载 Worker：并发来自后台设置 queue_config.download（Worker 启动时读取）
export async function startAssetWorker(concurrency: number): Promise<Worker<AssetDownloadJobData> | null> {
  if (!assetQueueEnabled() || assetWorker) return assetWorker;
  assetWorker = new Worker<AssetDownloadJobData>(
    ASSET_QUEUE_NAME,
    async (job) => {
      await downloadVideoAsset(job.data.taskId);
    },
    {
      connection: new IORedis(process.env.REDIS_URL!, redisOpts()),
      concurrency: Math.max(1, Math.floor(concurrency)),
      lockDuration: 300_000,
      // 空队列时阻塞等待 30 秒再重新检查（默认 5 秒）；有新任务入队时阻塞命令立即返回
      drainDelay: 30,
    }
  );
  assetWorker.on("error", (e) => {
    console.error("[asset-worker] 任务处理异常:", e.message.slice(0, 200));
  });
  assetWorker.on("failed", (job, err) => {
    console.error(`[asset-worker] job ${job?.id} 最终失败:`, err.message.slice(0, 200));
  });
  console.log(`[asset-worker] 已启动 queue=${ASSET_QUEUE_NAME} concurrency=${assetWorker.concurrency}`);
  return assetWorker;
}

export function getAssetWorker() {
  return assetWorker;
}
