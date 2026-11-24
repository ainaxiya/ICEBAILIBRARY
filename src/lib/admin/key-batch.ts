// ─── 渠道（vendor_api_key）批量运营：纯函数逻辑 ───
// 与路由分离，便于单测覆盖：标签归一 / 打标合并 / 一致性修复判定

export const KEY_STATUS = ["active", "disabled"] as const;
export type KeyStatus = (typeof KEY_STATUS)[number];

// 单个标签最长 20 字符，单 Key 最多 20 个标签
export const TAG_MAX_LEN = 20;
export const TAG_MAX_COUNT = 20;

export type TagOp = "add" | "remove" | "replace";

// 标签输入归一：支持数组或「逗号 / 中文逗号 / 顿号 / 换行」分隔字符串；
// 去空白、去空项、去重、截断超长标签、限制数量。
export function normalizeTags(raw: unknown): string[] {
  const parts: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") parts.push(item);
    }
  } else if (typeof raw === "string") {
    parts.push(...raw.split(/[,，、\n\r]+/));
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const tag = part.trim().slice(0, TAG_MAX_LEN);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= TAG_MAX_COUNT) break;
  }
  return out;
}

// 打标：在已有标签上追加 / 移除 / 整体替换（结果仍按 normalizeTags 口径收敛）
export function applyTagOp(existing: unknown, op: TagOp, incoming: unknown): string[] {
  const base = normalizeTags(existing);
  const next = normalizeTags(incoming);
  if (op === "replace") return next;
  if (op === "remove") {
    const drop = new Set(next);
    return base.filter((t) => !drop.has(t));
  }
  return normalizeTags([...base, ...next]);
}

// 一致性修复输入（只取修复需要的字段）
export type KeyRepairInput = {
  id: number;
  status: string;
  weight: number;
  maintainUntil: Date | null;
};

export type KeyRepairFix = {
  id: number;
  field: "status" | "weight" | "maintainUntil";
  from: string | number | null;
  to: string | number | null;
};

// 一致性修复判定（纯函数）：
// 1) 非法状态 → disabled（避免脏状态绕过选路过滤）
// 2) 权重 < 1 → 1（加权选路要求 ≥1）
// 3) 维护窗口已过期 → 清空（避免列表一直显示维护中）
export function planKeyRepairs(keys: KeyRepairInput[], now: number = Date.now()): KeyRepairFix[] {
  const fixes: KeyRepairFix[] = [];
  for (const key of keys) {
    if (!(KEY_STATUS as readonly string[]).includes(key.status)) {
      fixes.push({ id: key.id, field: "status", from: key.status, to: "disabled" });
    }
    if (!Number.isFinite(key.weight) || key.weight < 1) {
      fixes.push({ id: key.id, field: "weight", from: key.weight, to: 1 });
    }
    if (key.maintainUntil && key.maintainUntil.getTime() <= now) {
      fixes.push({
        id: key.id,
        field: "maintainUntil",
        from: key.maintainUntil.toISOString(),
        to: null,
      });
    }
  }
  return fixes;
}

// 单条测活结果 → 是否计入「可用」（HTTP 2xx/3xx 视为可用）
export function isProbeSuccess(status: number): boolean {
  return status >= 200 && status < 400;
}
