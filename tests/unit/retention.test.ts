import { describe, it, expect } from "vitest";
import {
  purgeTable,
  readRetentionConfig,
  retentionCutoff,
  runRetention,
  type RetentionStore,
  type RetentionTable,
} from "@/lib/retention";

// ─── x3 大表分批清理：默认 dry-run、单批限量、按日切 cutoff ───

function fakeStore(expired: number, batchSizes: number[]) {
  const calls = { count: 0, del: 0, limit: [] as number[], tables: [] as RetentionTable[] };
  const store: RetentionStore = {
    async countExpired(_table, _cutoff) {
      calls.count += 1;
      return expired;
    },
    async deleteBatch(table, _cutoff, limit) {
      calls.del += 1;
      calls.limit.push(limit);
      calls.tables.push(table);
      return batchSizes.shift() ?? 0;
    },
  };
  return { store, calls };
}

const NOW = new Date("2026-11-19T10:30:00.000Z");

describe("retention 保留期清理", () => {
  it("默认配置：dry-run、保留天数未配置、单批 2000 / 最多 20 批", () => {
    const cfg = readRetentionConfig({});
    expect(cfg).toEqual({
      usageDays: null,
      ledgerDays: null,
      batchSize: 2000,
      maxBatches: 20,
      dryRun: true,
    });
  });

  it("必须显式 RETENTION_DELETE_ENABLED=1/true 才关闭 dry-run", () => {
    expect(readRetentionConfig({ RETENTION_DELETE_ENABLED: "true" }).dryRun).toBe(false);
    expect(readRetentionConfig({ RETENTION_DELETE_ENABLED: "1" }).dryRun).toBe(false);
    expect(readRetentionConfig({ RETENTION_DELETE_ENABLED: "TRUE" }).dryRun).toBe(false);
    expect(readRetentionConfig({ RETENTION_DELETE_ENABLED: "0" }).dryRun).toBe(true);
    expect(readRetentionConfig({ RETENTION_DELETE_ENABLED: "yes" }).dryRun).toBe(true);
  });

  it("非法保留天数视为未配置（不清理），批量参数夹取到安全范围", () => {
    const cfg = readRetentionConfig({
      RETENTION_USAGE_DAYS: "0",
      RETENTION_LEDGER_DAYS: "abc",
      RETENTION_BATCH_SIZE: "99999",
      RETENTION_MAX_BATCHES: "-3",
    });
    expect(cfg.usageDays).toBeNull();
    expect(cfg.ledgerDays).toBeNull();
    expect(cfg.batchSize).toBe(10000);
    expect(cfg.maxBatches).toBe(1);
  });

  it("cutoff 按 UTC 日切：保留 N 个完整自然日", () => {
    expect(retentionCutoff(30, NOW).toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(retentionCutoff(1, NOW).toISOString()).toBe("2026-11-18T00:00:00.000Z");
  });

  it("dry-run 只统计、绝不删除", async () => {
    const { store, calls } = fakeStore(120, []);
    const r = await purgeTable("usage_record", 180, { dryRun: true, batchSize: 50, maxBatches: 10 }, store, NOW);
    expect(r).toMatchObject({ expired: 120, deleted: 0, batches: 0, dryRun: true });
    expect(calls.count).toBe(1);
    expect(calls.del).toBe(0);
  });

  it("无过期数据时不发起删除", async () => {
    const { store, calls } = fakeStore(0, []);
    const r = await purgeTable("credit_ledger", 365, { dryRun: false, batchSize: 100, maxBatches: 5 }, store, NOW);
    expect(r).toMatchObject({ expired: 0, deleted: 0, batches: 0 });
    expect(calls.del).toBe(0);
  });

  it("分批删除直到出现不足一批", async () => {
    const { store, calls } = fakeStore(5, [2, 2, 1]);
    const r = await purgeTable("usage_record", 90, { dryRun: false, batchSize: 2, maxBatches: 10 }, store, NOW);
    expect(r).toMatchObject({ deleted: 5, batches: 3, reachedBatchLimit: false });
    expect(calls.limit).toEqual([2, 2, 2]);
  });

  it("命中单次批数上限即停，标记下次继续", async () => {
    const { store } = fakeStore(100, [4, 4, 4]);
    const r = await purgeTable("credit_ledger", 365, { dryRun: false, batchSize: 4, maxBatches: 3 }, store, NOW);
    expect(r).toMatchObject({ deleted: 12, batches: 3, reachedBatchLimit: true });
  });

  it("runRetention 只跑配置了保留天数的表", async () => {
    const { store, calls } = fakeStore(3, [3]);
    const cfg = readRetentionConfig({ RETENTION_USAGE_DAYS: "30" });
    const out = await runRetention(cfg, store, NOW);
    expect(out.dryRun).toBe(true);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ table: "usage_record", retentionDays: 30, deleted: 0 });
    expect(calls.count).toBe(1);
    expect(calls.del).toBe(0);
  });
});
