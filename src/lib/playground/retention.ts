import { db } from "@/lib/db";

// ─── 冰山实验场：会话保留期（pa 组口径：默认 90 天，默认干跑） ───
// - 保留天数：默认 90 天；可用 PLAYGROUND_SESSION_RETENTION_DAYS 覆盖（<=0 关闭清理）
// - 清理动作：默认干跑（只统计不删除）；确认无误后设 PLAYGROUND_RETENTION_DRY_RUN=0 才真删
// - 产物保留 30 天由 GeneratedAsset.expireAt 控制（见 lib/assets.ts），积分流水永久不删

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;

export function playgroundRetentionDays(): number {
  const raw = process.env.PLAYGROUND_SESSION_RETENTION_DAYS;
  if (raw == null || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function playgroundRetentionDryRun(): boolean {
  const raw = (process.env.PLAYGROUND_RETENTION_DRY_RUN ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

// 统计/删除该用户超过保留期的会话（消息随外键级联删除）。
// 干跑时只返回命中数量、不删除；未启用时返回 0。
export async function purgeExpiredSessions(userId: number): Promise<number> {
  const days = playgroundRetentionDays();
  if (days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * DAY_MS);
  const where = { userId, updatedAt: { lt: cutoff } };

  if (playgroundRetentionDryRun()) {
    const scanned = await db.playgroundSession.count({ where });
    if (scanned > 0) {
      console.info(
        `[playground-retention] 干跑：用户 ${userId} 有 ${scanned} 个会话超过 ${days} 天（未删除，设 PLAYGROUND_RETENTION_DRY_RUN=0 才执行）`
      );
    }
    return scanned;
  }

  const res = await db.playgroundSession.deleteMany({ where });
  if (res.count > 0) {
    console.info(`[playground-retention] 已清理用户 ${userId} 的 ${res.count} 个过期会话（>${days} 天）`);
  }
  return res.count;
}
