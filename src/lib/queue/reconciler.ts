// ─── P6 #21 DB ↔ Redis 队列对账（60 秒一轮）──
// 解决三类「数据库状态与队列不一致」的孤儿任务：
//   ① queued 超过 30 秒但 Redis 里没有 job（入队丢失 / job 已终态）→ 重投；
//   ② processing 租约过期（Worker 崩溃/僵死）→ attempts < 3 重投，attempts ≥ 3 收口失败并退款；
//   ③ succeeded 但 assetId 为空（转存失败）→ 补投独立产物下载队列。
// 重投所需执行上下文从 video_task.payload（v2 扩展 JSON）重建；v1 旧载荷无法重建则跳过，不误跑。
// 第一段挂在 web 进程模块加载；第二段迁到独立 Worker 进程。
import type { VideoTask } from "@prisma/client";
import { db } from "@/lib/db";
import { failVideoTask, LEASE_MS, VIDEO_MAX_ATTEMPTS } from "@/lib/gateway/video-task";
import { enqueueAssetDownload } from "./asset-queue";
import { ensureVideoJob, queueEnabled, removeVideoJob, type VideoQueueJobData } from "./video-queue";

const QUEUED_GRACE_MS = 30_000;
const ASSET_GRACE_MS = 60_000;
const SCAN_LIMIT = 200;

export interface ReconcileReport {
  queuedRequeued: number;
  leaseRequeued: number;
  failed: number;
  assetsEnqueued: number;
  skipped: number;
  errors: number;
}

// payload v2 → 队列载荷；旧格式（只有 body）返回 null，交由调用方跳过
function rebuildJobData(row: VideoTask): VideoQueueJobData | null {
  try {
    const p = JSON.parse(row.payload) as {
      v?: number;
      body?: unknown;
      pricing?: unknown;
      baseUsage?: unknown;
      durationSec?: number;
      started?: number;
      vendorKeyIds?: number[];
    };
    if (p.v !== 2) return null;
    if (!p.body || typeof p.body !== "object") return null;
    if (!p.pricing || typeof p.pricing !== "object") return null;
    if (!p.baseUsage || typeof p.baseUsage !== "object") return null;
    if (!Array.isArray(p.vendorKeyIds) || p.vendorKeyIds.length === 0) return null;
    return {
      taskId: row.taskId,
      vendorKeyIds: p.vendorKeyIds,
      body: p.body as Record<string, unknown>,
      baseUsage: p.baseUsage as VideoQueueJobData["baseUsage"],
      pricing: p.pricing as VideoQueueJobData["pricing"],
      durationSec: Number(p.durationSec) || 0,
      started: Number(p.started) || Date.now(),
    };
  } catch {
    return null;
  }
}

export async function runQueueReconciler(): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    queuedRequeued: 0,
    leaseRequeued: 0,
    failed: 0,
    assetsEnqueued: 0,
    skipped: 0,
    errors: 0,
  };
  if (!queueEnabled()) return report;
  const now = Date.now();

  // ① queued 超 30 秒：Redis 无 job 或 job 已终态 → 重投
  const queuedRows = await db.videoTask.findMany({
    where: { status: "queued", createdAt: { lt: new Date(now - QUEUED_GRACE_MS) } },
    take: SCAN_LIMIT,
  });
  for (const row of queuedRows) {
    const data = rebuildJobData(row);
    if (!data) {
      report.skipped++;
      continue;
    }
    const r = await ensureVideoJob(data);
    if (r.ok) report.queuedRequeued++;
    else report.errors++;
  }

  // ② processing 租约过期（旧数据 lockedUntil 为空时按 updatedAt 超一个租约判断）
  const processingRows = await db.videoTask.findMany({
    where: {
      status: "processing",
      OR: [
        { lockedUntil: { lt: new Date(now) } },
        { lockedUntil: null, updatedAt: { lt: new Date(now - LEASE_MS) } },
      ],
    },
    take: SCAN_LIMIT,
  });
  for (const row of processingRows) {
    if (row.attempts >= VIDEO_MAX_ATTEMPTS) {
      await removeVideoJob(row.taskId);
      const ok = await failVideoTask(row.taskId, "任务多次重试仍未完成，费用已原路退回");
      if (ok) report.failed++;
      else report.skipped++;
      continue;
    }
    const data = rebuildJobData(row);
    if (!data) {
      report.skipped++;
      continue;
    }
    const r = await ensureVideoJob(data);
    if (r.ok) report.leaseRequeued++;
    else report.errors++;
  }

  // ③ 成功但没有 assetId（转存失败）→ 补投独立下载队列
  const noAssetRows = await db.videoTask.findMany({
    where: {
      status: "succeeded",
      assetId: null,
      resultUrls: { not: null },
      updatedAt: { lt: new Date(now - ASSET_GRACE_MS) },
    },
    take: SCAN_LIMIT,
  });
  for (const row of noAssetRows) {
    const r = await enqueueAssetDownload({ taskId: row.taskId, userId: row.userId, requestId: row.requestId });
    if (r.ok) report.assetsEnqueued++;
    else report.errors++;
  }

  return report;
}

let timer: NodeJS.Timeout | null = null;

// 启动对账循环（幂等；未配置 REDIS_URL 不启动）
export function startQueueReconciler(intervalMs = 60_000): void {
  if (!queueEnabled() || timer) return;
  const tick = () => {
    void runQueueReconciler()
      .then((r) => {
        if (r.queuedRequeued || r.leaseRequeued || r.failed || r.assetsEnqueued || r.errors) {
          console.log(
            `[queue-reconciler] queued重投=${r.queuedRequeued} lease重投=${r.leaseRequeued} ` +
              `收口失败=${r.failed} 补投下载=${r.assetsEnqueued} 跳过=${r.skipped} 错误=${r.errors}`
          );
        }
      })
      .catch((e) => console.error("[queue-reconciler] 扫描失败:", (e as Error).message.slice(0, 200)));
  };
  timer = setInterval(tick, intervalMs);
  timer.unref();
  // 首轮稍等再跑，避开进程刚启动时 worker 尚未就绪的窗口
  setTimeout(tick, 10_000).unref();
  console.log(`[queue-reconciler] 已启动 interval=${intervalMs}ms`);
}
