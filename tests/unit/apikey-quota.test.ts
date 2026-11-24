import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import {
  createApiKey,
  releaseApiKeyQuota,
  reserveApiKeyQuota,
  setApiKeyQuota,
  verifyApiKey,
} from "@/lib/apikey";

// ─── b2 硬额度：额度边界 / 超卖 / 不限额 ───
// 口径：quotaCredits=null 不限额；usedCredits 为原子计数器；
// 预占（reserve）成功才扣分，结算/退款（release）按 requestId 收口。

let uid: number;
let reqSeq = 0;
const reqId = () => `unit-quota-${Date.now()}-${reqSeq++}`;

async function usedOf(keyId: number): Promise<number> {
  const row = await db.userApiKey.findUnique({ where: { id: keyId }, select: { usedCredits: true } });
  return Number(row?.usedCredits ?? 0);
}

beforeAll(async () => {
  const user = await db.user.upsert({
    where: { username: "unit-apikey-quota-user" },
    update: { status: "active" },
    create: { username: "unit-apikey-quota-user", passwordHash: "x", status: "active" },
  });
  uid = user.id;
  const stale = await db.userApiKey.findMany({ where: { userId: uid }, select: { id: true } });
  if (stale.length) {
    await db.apiKeyQuotaHold.deleteMany({ where: { apiKeyId: { in: stale.map((k) => k.id) } } });
  }
  await db.userApiKey.deleteMany({ where: { userId: uid } });
});

afterAll(async () => {
  const keys = await db.userApiKey.findMany({ where: { userId: uid }, select: { id: true } });
  const ids = keys.map((k) => k.id);
  if (ids.length) await db.apiKeyQuotaHold.deleteMany({ where: { apiKeyId: { in: ids } } });
  await db.userApiKey.deleteMany({ where: { userId: uid } });
  await db.usageRecord.deleteMany({ where: { userId: uid } });
  await db.$disconnect();
});

describe("b2 Key 硬额度", () => {
  it("刚好用满：预占累计等于额度即封顶，鉴权转 quotaExceeded", async () => {
    const k = await createApiKey(uid, null, "quota-exact", 100);
    expect((await reserveApiKeyQuota(k.id, reqId(), 60)).ok).toBe(true);
    // 60 + 40 = 100，刚好用满仍可放行
    expect((await reserveApiKeyQuota(k.id, reqId(), 40)).ok).toBe(true);
    expect(await usedOf(k.id)).toBe(100);

    const exceeded = await verifyApiKey(k.plaintext);
    expect(exceeded.ok).toBe(false);
    if (!exceeded.ok) {
      expect(exceeded.quotaExceeded).toBe(true);
      expect(exceeded.error).toContain("quota");
    }
  });

  it("超额：拒绝并保持已用不变（不扣分）", async () => {
    const k = await createApiKey(uid, null, "quota-overflow", 100);
    expect((await reserveApiKeyQuota(k.id, reqId(), 80)).ok).toBe(true);
    const over = await reserveApiKeyQuota(k.id, reqId(), 30);
    expect(over.ok).toBe(false);
    expect(over.code).toBe("key_quota_exceeded");
    expect(await usedOf(k.id)).toBe(80);
  });

  it("额度为 null 不限额：任意预占都放行", async () => {
    const k = await createApiKey(uid, null, "quota-unlimited", null);
    for (let i = 0; i < 3; i++) {
      expect((await reserveApiKeyQuota(k.id, reqId(), 100000)).ok).toBe(true);
    }
    expect(await usedOf(k.id)).toBe(300000);
    expect((await verifyApiKey(k.plaintext)).ok).toBe(true);
  });

  it("并发预占不超卖：额度 50、10 个并发各 10，恰好 5 个成功", async () => {
    const k = await createApiKey(uid, null, "quota-concurrent", 50);
    const reqs = Array.from({ length: 10 }, () => reqId());
    const results = await Promise.all(reqs.map((r) => reserveApiKeyQuota(k.id, r, 10)));
    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(5);
    expect(await usedOf(k.id)).toBe(50);
  });

  it("结算/退款收口：release 按实际积分多退少补，全额释放归还预占", async () => {
    const k = await createApiKey(uid, null, "quota-release", 1000);
    const r1 = reqId();
    expect((await reserveApiKeyQuota(k.id, r1, 100)).ok).toBe(true);
    // 实际只用了 30：退回 70
    await releaseApiKeyQuota(r1, 30);
    expect(await usedOf(k.id)).toBe(30);

    const r2 = reqId();
    expect((await reserveApiKeyQuota(k.id, r2, 200)).ok).toBe(true);
    // 失败退款：全额释放 200
    await releaseApiKeyQuota(r2);
    expect(await usedOf(k.id)).toBe(30);
  });

  it("设置额度时回填历史用量：老 Key 设额度不会从 0 起算", async () => {
    const k = await createApiKey(uid, null, "quota-backfill", null);
    await db.usageRecord.create({
      data: {
        userId: uid,
        apiKeyId: BigInt(k.id),
        channel: "apikey",
        endpointType: "chat",
        modelSnapshot: "unit-model",
        paidCredits: 77n,
        status: "success",
        requestId: reqId(),
      },
    });
    expect(await setApiKeyQuota(k.id, 500, uid)).toBe(true);
    expect(await usedOf(k.id)).toBe(77);
    const row = await db.userApiKey.findUnique({ where: { id: k.id }, select: { quotaCredits: true } });
    expect(row?.quotaCredits).toBe(500);
  });

  it("设置额度仅限本人：他人不能改", async () => {
    const k = await createApiKey(uid, null, "quota-owner", 100);
    expect(await setApiKeyQuota(k.id, 999, uid + 100000)).toBe(false);
  });
});
