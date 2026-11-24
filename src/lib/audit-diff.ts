// 审计日志「变更前后」：统一记录/读取字段级差异，供后台操作日志视图展示
// 约定：detail JSON 里可带 `changes: [{ field, label?, before, after }]`，
// 与既有扁平字段（模型名、计数等）共存，旧日志无 changes 时视图自动回退。

export type AuditChange = {
  field: string;
  label?: string;
  before: unknown;
  after: unknown;
};

const MAX_TEXT = 200;

// 快照值归一化：Date → ISO、Decimal → number、bigint → number、超长文本截断
export function auditValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  const d = v as { toNumber?: () => number };
  if (d && typeof d.toNumber === "function") return d.toNumber();
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

// 只输出真正发生变化的字段（顺序按传入 fields）
export function diffFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  fields: readonly string[],
  labels?: Record<string, string>
): AuditChange[] {
  const out: AuditChange[] = [];
  for (const field of fields) {
    const b = auditValue(before?.[field]);
    const a = auditValue(after?.[field]);
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    out.push({ field, label: labels?.[field], before: b, after: a });
  }
  return out;
}

// 把 changes 合并进既有 detail（无变更时保持原样）
export function withChanges(detail: Record<string, unknown>, changes: AuditChange[]): string {
  return JSON.stringify(changes.length > 0 ? { ...detail, changes } : detail);
}

// 从 detail JSON 中提取 changes；旧日志/非法 JSON 返回空数组
export function extractChanges(detail: string | null | undefined): AuditChange[] {
  if (!detail) return [];
  try {
    const obj = JSON.parse(detail) as { changes?: unknown };
    if (!Array.isArray(obj?.changes)) return [];
    return obj.changes
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as any).field === "string")
      .map((c) => ({
        field: String(c.field),
        label: typeof c.label === "string" && c.label ? c.label : undefined,
        before: (c as any).before ?? null,
        after: (c as any).after ?? null,
      }));
  } catch {
    return [];
  }
}
