// ─── b15 上游模型变更检测：新增 / 下线 / 恢复 / 参数变化（纯函数） ───

export type SyncItem = {
  name: string;
  available: boolean;
  inDb: boolean;
  dbStatus: string | null;
  unavailableReason: string | null;
  videoParams: Record<string, unknown> | null;
};

export type SyncDbModel = {
  name: string;
  status: string;
  advancedConfig: string | null;
};

export type ModelDiff = {
  added: string[]; // 上游可用、库内没有 → 新增入库
  toOffline: string[]; // 上游不可用、库内仍在线 → 标记下线（retiring 不算）
  toRestore: string[]; // 上游恢复可用、库内 offline → 恢复在线
  paramChanged: string[]; // 库内在线，但视频功能参数与高级配置不一致
  counts: { added: number; toOffline: number; toRestore: number; paramChanged: number };
};

// 稳定序列化（对象键排序），忽略空白差异
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function parseConfig(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 已明确下架的模型（advancedConfig.offline / model_spec.offline = true）
// 不再默认进入「可恢复」：上游目录可能仍残留条目，避免同步预览一键把它拉回在线。
// 需要恢复时，先在后台把该标记改回 false。
function isExplicitlyOffline(raw: string | null): boolean {
  const cfg = parseConfig(raw);
  if (!cfg || typeof cfg !== "object") return false;
  const obj = cfg as Record<string, unknown>;
  if (obj.offline === true) return true;
  const spec = obj.model_spec;
  return !!spec && typeof spec === "object" && (spec as Record<string, unknown>).offline === true;
}

export function computeModelDiff(
  items: SyncItem[],
  dbModels: SyncDbModel[],
  now: number = Date.now()
): ModelDiff {
  void now;
  const dbMap = new Map(dbModels.map((m) => [m.name, m]));
  const added: string[] = [];
  const toOffline: string[] = [];
  const toRestore: string[] = [];
  const paramChanged: string[] = [];

  for (const item of items) {
    const db = dbMap.get(item.name) ?? null;
    if (!item.inDb || !db) {
      if (item.available) added.push(item.name);
      continue;
    }
    // 待下线（Retiring）不断流量，与入库接口口径一致
    if (!item.available && item.unavailableReason !== "retiring" && db.status !== "offline") {
      toOffline.push(item.name);
      continue;
    }
    const oldRaw = parseConfig(db.advancedConfig);
    if (item.available && db.status === "offline" && !isExplicitlyOffline(db.advancedConfig)) {
      toRestore.push(item.name);
    }
    if (item.available && item.videoParams) {
      if (oldRaw !== null && stableStringify(oldRaw) !== stableStringify(item.videoParams)) {
        paramChanged.push(item.name);
      }
    }
  }

  return {
    added,
    toOffline,
    toRestore,
    paramChanged,
    counts: {
      added: added.length,
      toOffline: toOffline.length,
      toRestore: toRestore.length,
      paramChanged: paramChanged.length,
    },
  };
}
