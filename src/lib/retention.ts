// x3 用量 / 流水大表分批清理（默认 dry-run，必须显式开启才删除）
//
// 设计口径：
// - 只处理 usage_record 与 credit_ledger；
// - 保留 N 个完整 UTC 自然日：cutoff = UTC 当日 0 点 − N 天；
// - 按 (createdAt, id) keyset 分批删除，单批限量 + 单次总批数限量，避免长事务与锁表；
// - dry-run（默认）只统计过期行数，不执行任何 DELETE；
// - 不在应用内调度：需要时由运维 / 日切任务显式调用 runRetention。
//
// 风险提示（为何默认关闭）：
// - credit_ledger 是幂等凭据：历史 requestId 被清掉后，极晚到达的同 requestId 退款会失去幂等保护，
//   且审计链断裂。建议流水保留期明显长于退款窗口，或干脆不清理流水。
// - usage_record 被后台报表与计费对账使用，保留期需覆盖对账 / 审计周期。

export type RetentionTable = "usage_record" | "credit_ledger";

export type RetentionConfig = {
  /** null = 未配置，跳过该表（默认不清理） */
  usageDays: number | null;
  ledgerDays: number | null;
  /** 单批删除行数 */
  batchSize: number;
  /** 单次运行最多批数（防止一次跑太久） */
  maxBatches: number;
  /** true = 只统计不删除 */
  dryRun: boolean;
};

export type RetentionStore = {
  countExpired(table: RetentionTable, cutoff: Date): Promise<number>;
  /** 返回本批实际删除行数 */
  deleteBatch(table: RetentionTable, cutoff: Date, limit: number): Promise<number>;
};

export type RetentionTableResult = {
  table: RetentionTable;
  retentionDays: number;
  cutoff: string;
  dryRun: boolean;
  /** 清理前统计的过期总行数 */
  expired: number;
  deleted: number;
  batches: number;
  /** 命中单次批数上限仍有剩余（下次运行继续） */
  reachedBatchLimit: boolean;
};

function positiveInt(raw: string | undefined): number | null {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 从环境变量读取配置。
 * - RETENTION_USAGE_DAYS / RETENTION_LEDGER_DAYS：保留天数，未配置或非法 = 不清理该表
 * - RETENTION_BATCH_SIZE：单批行数，默认 2000（1 - 10000）
 * - RETENTION_MAX_BATCHES：单次最多批数，默认 20（1 - 1000）
 * - RETENTION_DELETE_ENABLED：必须显式设为 1 / true 才真正删除，否则一律 dry-run
 */
export function readRetentionConfig(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  const del = (env.RETENTION_DELETE_ENABLED ?? "").trim().toLowerCase();
  return {
    usageDays: positiveInt(env.RETENTION_USAGE_DAYS),
    ledgerDays: positiveInt(env.RETENTION_LEDGER_DAYS),
    batchSize: clampInt(env.RETENTION_BATCH_SIZE, 2000, 1, 10000),
    maxBatches: clampInt(env.RETENTION_MAX_BATCHES, 20, 1, 1000),
    dryRun: del !== "1" && del !== "true",
  };
}

/** UTC 当日 0 点 */
export function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** 保留 N 个完整 UTC 自然日后的 cutoff（该时间之前的行才是过期行） */
export function retentionCutoff(days: number, now: Date = new Date()): Date {
  return new Date(utcDayStart(now).getTime() - days * 86_400_000);
}

/**
 * 清理单表：dry-run 只统计；非 dry-run 分批删除直到无更多数据或命中批数上限。
 */
export async function purgeTable(
  table: RetentionTable,
  retentionDays: number,
  opts: { dryRun: boolean; batchSize: number; maxBatches: number },
  store: RetentionStore,
  now: Date = new Date()
): Promise<RetentionTableResult> {
  const cutoff = retentionCutoff(retentionDays, now);
  const expired = await store.countExpired(table, cutoff);
  const result: RetentionTableResult = {
    table,
    retentionDays,
    cutoff: cutoff.toISOString(),
    dryRun: opts.dryRun,
    expired,
    deleted: 0,
    batches: 0,
    reachedBatchLimit: false,
  };
  if (opts.dryRun || expired === 0) return result;

  while (result.batches < opts.maxBatches) {
    const n = await store.deleteBatch(table, cutoff, opts.batchSize);
    result.batches += 1;
    result.deleted += n;
    if (n < opts.batchSize) break;
    if (result.batches === opts.maxBatches) result.reachedBatchLimit = true;
  }
  return result;
}

/** 按配置逐表执行；未配置保留天数的表直接跳过（不产生结果项） */
export async function runRetention(
  config: RetentionConfig,
  store: RetentionStore,
  now: Date = new Date()
): Promise<{ dryRun: boolean; results: RetentionTableResult[] }> {
  const results: RetentionTableResult[] = [];
  if (config.usageDays != null) {
    results.push(
      await purgeTable("usage_record", config.usageDays, config, store, now)
    );
  }
  if (config.ledgerDays != null) {
    results.push(
      await purgeTable("credit_ledger", config.ledgerDays, config, store, now)
    );
  }
  return { dryRun: config.dryRun, results };
}

// ─── Prisma 适配器（不在测试中调用；表名来自封闭联合，不拼接外部输入） ───

type RawDb = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

const TABLE_SQL: Record<RetentionTable, string> = {
  usage_record: '"usage_record"',
  credit_ledger: '"credit_ledger"',
};

export function createPrismaRetentionStore(db: RawDb): RetentionStore {
  return {
    async countExpired(table, cutoff) {
      const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*)::bigint AS n FROM ${TABLE_SQL[table]} WHERE "createdAt" < $1`,
        cutoff
      );
      return Number(rows[0]?.n ?? 0);
    },
    async deleteBatch(table, cutoff, limit) {
      return db.$executeRawUnsafe(
        `DELETE FROM ${TABLE_SQL[table]}
         WHERE "id" IN (
           SELECT "id" FROM ${TABLE_SQL[table]}
           WHERE "createdAt" < $1
           ORDER BY "createdAt" ASC, "id" ASC
           LIMIT $2
         )`,
        cutoff,
        limit
      );
    },
  };
}
