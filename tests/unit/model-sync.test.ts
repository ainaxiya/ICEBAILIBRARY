import { describe, expect, it } from "vitest";
import { computeModelDiff, type SyncDbModel, type SyncItem } from "@/lib/admin/model-sync";

const item = (over: Partial<SyncItem>): SyncItem => ({
  name: "m",
  available: true,
  inDb: false,
  dbStatus: null,
  unavailableReason: null,
  videoParams: null,
  ...over,
});

const db = (over: Partial<SyncDbModel>): SyncDbModel => ({
  name: "m",
  status: "online",
  advancedConfig: null,
  ...over,
});

describe("computeModelDiff", () => {
  it("上游可用且未入库 → 新增", () => {
    const d = computeModelDiff([item({ name: "new-1" })], []);
    expect(d.added).toEqual(["new-1"]);
    expect(d.counts.added).toBe(1);
  });

  it("上游不可用且库内在线 → 下线；Retiring 不动", () => {
    const items = [
      item({ name: "dead", available: false, inDb: true, dbStatus: "online", unavailableReason: "status_unavailable" }),
      item({ name: "retiring", available: false, inDb: true, dbStatus: "online", unavailableReason: "retiring" }),
    ];
    const rows = [db({ name: "dead" }), db({ name: "retiring" })];
    const d = computeModelDiff(items, rows);
    expect(d.toOffline).toEqual(["dead"]);
    expect(d.toRestore).toEqual([]);
  });

  it("上游恢复可用且库内下线 → 可恢复", () => {
    const items = [item({ name: "back", available: true, inDb: true, dbStatus: "offline" })];
    const d = computeModelDiff(items, [db({ name: "back", status: "offline" })]);
    expect(d.toRestore).toEqual(["back"]);
  });

  it("已显式下架（model_spec.offline）的模型不进入可恢复", () => {
    const items = [item({ name: "gone", available: true, inDb: true, dbStatus: "offline" })];
    const rows = [
      db({
        name: "gone",
        status: "offline",
        advancedConfig: JSON.stringify({ model_spec: { offline: true } }),
      }),
    ];
    expect(computeModelDiff(items, rows).toRestore).toEqual([]);
  });

  it("顶层 offline=true 同样阻止恢复", () => {
    const items = [item({ name: "gone", available: true, inDb: true, dbStatus: "offline" })];
    const rows = [db({ name: "gone", status: "offline", advancedConfig: JSON.stringify({ offline: true }) })];
    expect(computeModelDiff(items, rows).toRestore).toEqual([]);
  });

  it("参数键顺序不同但内容一致 → 不算变化", () => {
    const items = [
      item({ name: "v", available: true, inDb: true, dbStatus: "online", videoParams: { b: 2, a: 1 } }),
    ];
    const rows = [db({ name: "v", advancedConfig: JSON.stringify({ a: 1, b: 2 }) })];
    expect(computeModelDiff(items, rows).paramChanged).toEqual([]);
  });

  it("参数内容不同 → 标记参数变化", () => {
    const items = [
      item({ name: "v", available: true, inDb: true, dbStatus: "online", videoParams: { a: 2 } }),
    ];
    const rows = [db({ name: "v", advancedConfig: JSON.stringify({ a: 1 }) })];
    expect(computeModelDiff(items, rows).paramChanged).toEqual(["v"]);
  });

  it("库内无高级配置时不做参数对比，避免误报", () => {
    const items = [item({ name: "v", available: true, inDb: true, dbStatus: "online", videoParams: { a: 1 } })];
    const rows = [db({ name: "v", advancedConfig: null })];
    expect(computeModelDiff(items, rows).paramChanged).toEqual([]);
  });
});
