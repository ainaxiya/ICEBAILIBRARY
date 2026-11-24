import { db } from "@/lib/db";
import { bucketToConfig, deleteObject } from "@/lib/s3";

// ─── P5 生成资产 30 天清理（方案 7.4） ───
// 查 expireAt<now 且 status=temp → 删桶内对象 + 标 deleted（软删不物理删行）。
// 定时任务本期不做（本地开发），留 cleanupExpiredAssets() 供
// POST /api/admin/assets/cleanup 手动触发，将来接 cron/定时器直接调用。

const BATCH_LIMIT = 500;

export interface CleanupSummary {
  scanned: number;
  deleted: number;
  failed: number;
  errors: string[];
  dryRun: boolean;
}

// pa 组口径：过期清理默认干跑，设 PLAYGROUND_RETENTION_DRY_RUN=0 才真正删除
export function assetCleanupDryRun(): boolean {
  const raw = (process.env.PLAYGROUND_RETENTION_DRY_RUN ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

export async function cleanupExpiredAssets(opts?: { dryRun?: boolean }): Promise<CleanupSummary> {
  const dryRun = opts?.dryRun ?? assetCleanupDryRun();
  const rows = await db.generatedAsset.findMany({
    where: { status: "temp", expireAt: { lt: new Date() } },
    include: { bucket: true },
    orderBy: { expireAt: "asc" },
    take: BATCH_LIMIT,
  });

  const summary: CleanupSummary = { scanned: rows.length, deleted: 0, failed: 0, errors: [], dryRun };
  if (dryRun) {
    if (rows.length > 0) {
      console.info(
        `[asset-cleanup] 干跑：命中 ${rows.length} 个过期产物（未删除，设 PLAYGROUND_RETENTION_DRY_RUN=0 才执行）`
      );
    }
    return summary;
  }
  for (const row of rows) {
    try {
      if (row.bucket) {
        await deleteObject(bucketToConfig(row.bucket), row.storageKey);
      }
      await db.generatedAsset.update({
        where: { id: row.id },
        data: { status: "deleted" },
      });
      summary.deleted++;
    } catch (e) {
      summary.failed++;
      if (summary.errors.length < 10) {
        summary.errors.push(`asset#${row.id}: ${(e as Error).message}`);
      }
    }
  }
  return summary;
}
