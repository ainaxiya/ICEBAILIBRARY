// 后台列表统一时间区间：dateFrom / dateTo 均为 YYYY-MM-DD，dateTo 含当天。
// 与 /api/admin/reports/usage 的口径保持一致（UTC 零点起，结束日次日零点止，左闭右开）。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateParam(v: string | null | undefined): string | null {
  const s = (v || "").trim();
  return DATE_RE.test(s) ? s : null;
}

/** 返回 Prisma 时间过滤条件；无有效日期时返回 undefined */
export function dateRangeFilter(
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined
): { gte?: Date; lt?: Date } | undefined {
  const from = parseDateParam(dateFrom);
  const to = parseDateParam(dateTo);
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
    ...(to ? { lt: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 24 * 3600 * 1000) } : {}),
  };
}
