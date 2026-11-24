import { describe, expect, it } from "vitest";
import {
  ALERT_TYPE_KEYS,
  alertMatchesSubscription,
  normalizeAdminEmail,
  parseAlertSubscriptions,
  serializeAlertSubscriptions,
} from "@/lib/admin/alert-subscription";

describe("b16 告警订阅解析", () => {
  it("NULL / 空串 / 空数组 都视为订阅全部（不可静默静音）", () => {
    expect(parseAlertSubscriptions(null)).toEqual([...ALERT_TYPE_KEYS]);
    expect(parseAlertSubscriptions("")).toEqual([...ALERT_TYPE_KEYS]);
    expect(parseAlertSubscriptions("[]")).toEqual([...ALERT_TYPE_KEYS]);
  });

  it("只保留已知类型，并保持固定顺序", () => {
    expect(parseAlertSubscriptions('["pay_fail","unknown","credit_pool"]')).toEqual([
      "credit_pool",
      "pay_fail",
    ]);
  });

  it("非法 JSON 回退全部", () => {
    expect(parseAlertSubscriptions("{not-json")).toEqual([...ALERT_TYPE_KEYS]);
    expect(parseAlertSubscriptions('{"a":1}')).toEqual([...ALERT_TYPE_KEYS]);
  });

  it("全选序列化为 NULL，部分订阅存 JSON", () => {
    expect(serializeAlertSubscriptions([...ALERT_TYPE_KEYS])).toBeNull();
    expect(serializeAlertSubscriptions([])).toBeNull();
    expect(serializeAlertSubscriptions(["pay_fail", "bogus"])).toBe('["pay_fail"]');
  });

  it("命中判断：未订阅的类型不发送，未知告警类型默认发送", () => {
    const raw = '["credit_pool"]';
    expect(alertMatchesSubscription(raw, "credit_pool")).toBe(true);
    expect(alertMatchesSubscription(raw, "pay_fail")).toBe(false);
    expect(alertMatchesSubscription(raw, "usage_invalid")).toBe(true);
    expect(alertMatchesSubscription(null, "pay_fail")).toBe(true);
  });
});

describe("b16 管理员邮箱规范化", () => {
  it("空值返回 null，合法邮箱 trim 后返回", () => {
    expect(normalizeAdminEmail(null)).toBeNull();
    expect(normalizeAdminEmail("   ")).toBeNull();
    expect(normalizeAdminEmail(" ops@example.com ")).toBe("ops@example.com");
  });

  it("非法邮箱返回 null，超长截断到 120", () => {
    expect(normalizeAdminEmail("not-an-email")).toBeNull();
    expect(normalizeAdminEmail("a@b")).toBeNull();
    const long = `${"x".repeat(130)}@example.com`;
    expect(normalizeAdminEmail(long)?.length).toBe(120);
  });
});
