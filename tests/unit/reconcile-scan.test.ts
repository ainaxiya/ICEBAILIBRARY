import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { scanReconcile } from "@/lib/gateway/billing-reconcile";
import { pricingSnapshot } from "@/lib/gateway/pricing";

// ─── P3 回归单测：对账扫描（异常用量 / 重试耗尽）+ 价格快照 ───
// 预扣卡账（reconcile_stuck）已整类取消：不再生成、不再断言，改为断言「旧卡账也不会再告警」。

const TS = Date.now();
const RID_STUCK = `unit-stuck-${TS}`;
const RID_NEGATIVE = `unit-neg-${TS}`;
const RID_TEST_ACCOUNT = `unit-neg-qatest-${TS}`;
const RID_FAILED = `unit-failed-${TS}`;

let uid: number;

beforeAll(async () => {
  const user = await db.user.upsert({
    where: { username: "unit-reconcile-user" },
    update: { status: "active" },
    create: { username: "unit-reconcile-user", passwordHash: "x", status: "active" },
  });
  uid = user.id;

  // ① 旧「预扣卡账」形态：只有 consume 流水、无 settle/refund 后缀（时间戳回拨 20 分钟）
  //    该类型已取消，扫描必须完全忽略它，不得再产生 reconcile_stuck。
  const stuck = await db.creditLedger.create({
    data: {
      userId: uid,
      changeAmount: -42n,
      balanceAfter: 499958n,
      reason: "consume",
      refType: "request",
      refId: RID_STUCK,
      requestId: RID_STUCK,
    },
  });
  await db.creditLedger.update({
    where: { id: stuck.id },
    data: { createdAt: new Date(Date.now() - 20 * 60_000) },
  });

  // ② 负数用量：应触发 usage_invalid
  await db.usageRecord.create({
    data: {
      userId: uid,
      channel: "onsite",
      endpointType: "chat",
      modelSnapshot: "unit-model",
      paidCredits: -3n,
      status: "success",
      requestId: RID_NEGATIVE,
    },
  });

  // ③ 测试账号（qatest_）的负数用量：不参与运营告警
  const qa = await db.user.upsert({
    where: { username: "qatest_unit_reconcile" },
    update: {},
    create: { username: "qatest_unit_reconcile", passwordHash: "x", status: "active" },
  });
  await db.usageRecord.create({
    data: {
      userId: qa.id,
      channel: "onsite",
      endpointType: "chat",
      modelSnapshot: "unit-model",
      paidCredits: -9n,
      status: "success",
      requestId: RID_TEST_ACCOUNT,
    },
  });

  // ④ 幂等重试耗尽的对账单：应触发 reconcile_failed
  await db.billingReconcile.create({
    data: {
      userId: uid,
      requestId: RID_FAILED,
      kind: "settle",
      amount: 42n,
      status: "failed",
      attempts: 3,
      lastError: "unit db down",
    },
  });
});

afterAll(async () => {
  // 只清本次用例产生的告警/夹具，避免污染本地测试库
  await db.operationalAlert
    .deleteMany({
      where: {
        OR: [
          { payload: { contains: RID_NEGATIVE } },
          { payload: { contains: RID_FAILED } },
          { payload: { contains: RID_STUCK } },
          { payload: { contains: RID_TEST_ACCOUNT } },
        ],
      },
    })
    .catch(() => {});
  await db.usageRecord.deleteMany({ where: { requestId: { in: [RID_NEGATIVE, RID_TEST_ACCOUNT] } } }).catch(() => {});
  await db.billingReconcile.deleteMany({ where: { requestId: RID_FAILED } }).catch(() => {});
  await db.creditLedger.deleteMany({ where: { requestId: RID_STUCK } }).catch(() => {});
  await db.$disconnect();
});

describe("scanReconcile（P3 对账扫描）", () => {
  it("负数用量 → usage_invalid；重试耗尽 → reconcile_failed；文案为中文并可读", async () => {
    await scanReconcile();

    const usageAlerts = await db.operationalAlert.findMany({
      where: { alertType: "usage_invalid", payload: { contains: RID_NEGATIVE } },
    });
    expect(usageAlerts).toHaveLength(1);
    expect(usageAlerts[0].level).toBe("critical");
    expect(usageAlerts[0].message).toContain("用量记录异常");
    expect(usageAlerts[0].message).toContain("unit-reconcile-user");

    const failedAlerts = await db.operationalAlert.findMany({
      where: { alertType: "reconcile_failed", payload: { contains: RID_FAILED } },
    });
    expect(failedAlerts).toHaveLength(1);
    expect(failedAlerts[0].level).toBe("critical");
    expect(failedAlerts[0].message).toContain("对账重试耗尽");
  });

  it("旧「预扣卡账」不再产生任何 reconcile_stuck 告警", async () => {
    await scanReconcile();
    const stuckAlerts = await db.operationalAlert.findMany({
      where: { alertType: "reconcile_stuck", payload: { contains: RID_STUCK } },
    });
    expect(stuckAlerts).toHaveLength(0);
  });

  it("qatest_ 测试账号不参与运营告警", async () => {
    await scanReconcile();
    const alerts = await db.operationalAlert.findMany({
      where: { payload: { contains: RID_TEST_ACCOUNT } },
    });
    expect(alerts).toHaveLength(0);
  });

  it("同一问题 12 小时内不重复告警（DB 级去重，含已确认）", async () => {
    await scanReconcile();
    await scanReconcile();

    const usageCount = await db.operationalAlert.count({
      where: { alertType: "usage_invalid", payload: { contains: RID_NEGATIVE } },
    });
    expect(usageCount).toBe(1);

    const failedCount = await db.operationalAlert.count({
      where: { alertType: "reconcile_failed", payload: { contains: RID_FAILED } },
    });
    expect(failedCount).toBe(1);
  });
});

describe("pricingSnapshot（P3 价格快照）", () => {
  it("Decimal/BigInt 全部可序列化为 JSON，字段完整", () => {
    const fake = {
      id: 7,
      meterBase: 1000,
      unit: "token",
      inputPrice: { toString: () => "0.5" } as unknown as PrismaDecimal,
      outputPrice: { toString: () => "1" } as unknown as PrismaDecimal,
      currency: "CNY",
      fxRateE8: 100000000n,
      multiplierBps: 150,
      memberInputPrice: { toString: () => "1" } as unknown as PrismaDecimal,
      memberOutputPrice: { toString: () => "2" } as unknown as PrismaDecimal,
      effectiveAt: new Date(),
      createdAt: new Date(),
    } as any;
    const { priceVersionId, priceSnapshot } = pricingSnapshot(fake);
    expect(priceVersionId).toBe(7);
    const parsed = JSON.parse(priceSnapshot);
    expect(parsed.meterBase).toBe(1000);
    expect(parsed.inputPrice).toBe("0.5");
    expect(parsed.memberOutputPrice).toBe("2");
    expect(parsed.fxRateE8).toBe("100000000");
  });
});

type PrismaDecimal = { toString: () => string };
