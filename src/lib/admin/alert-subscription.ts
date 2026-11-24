// ─── 告警订阅（b16）───
// AdminAccount.alertSubscriptions 存 JSON 数组；NULL / 空数组 = 订阅全部。
// 新告警类型默认跟随「全部」送达，避免新增类型后没人收到。

export const ALERT_TYPE_KEYS = ["credit_pool", "gross_margin", "pay_fail", "register_burst"] as const;
export type AlertSubscriptionType = (typeof ALERT_TYPE_KEYS)[number];

export const ALERT_TYPE_LABELS: Record<AlertSubscriptionType, string> = {
  credit_pool: "积分池告警",
  gross_margin: "毛利告警",
  pay_fail: "支付异常",
  register_burst: "注册异常",
};

// 历史类型也允许订阅，避免老告警类型无法分发
export const LEGACY_ALERT_TYPE_LABELS: Record<string, string> = {
  usage_invalid: "用量记录异常",
  reconcile_failed: "对账重试耗尽",
};

export function alertTypeLabel(type: string): string {
  return ALERT_TYPE_LABELS[type as AlertSubscriptionType] || LEGACY_ALERT_TYPE_LABELS[type] || "其他告警";
}

const KNOWN = new Set<string>(ALERT_TYPE_KEYS);

/** 解析订阅字段：任意非法值都回退「全部」，避免静默丢告警。 */
export function parseAlertSubscriptions(raw: string | null | undefined): AlertSubscriptionType[] {
  if (!raw || !raw.trim()) return [...ALERT_TYPE_KEYS];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [...ALERT_TYPE_KEYS];
    const picked = ALERT_TYPE_KEYS.filter((t) => arr.includes(t));
    // 显式保存了空数组 = 全部（与 NULL 同义，防止老数据把人静音）
    return picked.length > 0 ? picked : [...ALERT_TYPE_KEYS];
  } catch {
    return [...ALERT_TYPE_KEYS];
  }
}

/** 序列化订阅：选择全部时存 NULL，减少无意义数据；其余存 JSON 数组。 */
export function serializeAlertSubscriptions(types: unknown): string | null {
  const arr = Array.isArray(types) ? types.filter((t): t is string => typeof t === "string" && KNOWN.has(t)) : [];
  if (arr.length === 0 || arr.length === ALERT_TYPE_KEYS.length) return null;
  return JSON.stringify(ALERT_TYPE_KEYS.filter((t) => arr.includes(t)));
}

/** 该管理员是否应收到此类型告警；未知类型默认送达（宁可多发，不可漏发）。 */
export function alertMatchesSubscription(raw: string | null | undefined, alertType: string): boolean {
  if (!KNOWN.has(alertType)) return true;
  return parseAlertSubscriptions(raw).includes(alertType as AlertSubscriptionType);
}

/** 邮箱规范化：空串视为未配置；明显非法返回 null。 */
export function normalizeAdminEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim();
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 120) : null;
}
