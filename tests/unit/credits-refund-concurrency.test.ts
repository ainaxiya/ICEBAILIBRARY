import { describe, it, expect, afterAll } from "vitest";
import { db } from "@/lib/db";
import { consume, refund, grant, getBalance } from "@/lib/credits";

// ─── L5 回归（直连 prompthub_test）：refund 必须用数据库行锁保证原子性 ───
// 覆盖：并发同 requestId 退款、并发不同 requestId 退款、退款 × 消费交叉。
// 守恒校验：Σ(ledger.changeAmount) === 当前余额（有效 grant 求和）。

let seq = 0;
async function freshUser(credits: bigint): Promise<number> {
  const user = await db.user.create({
    data: {
      username: `unit-l5-${Date.now()}-${++seq}`,
      passwordHash: "x",
      status: "active",
    },
  });
  await grant(user.id, "trial", credits, `unit-l5-fixture-${user.id}`);
  return user.id;
}

async function ledgerSum(userId: number): Promise<bigint> {
  const agg = await db.creditLedger.aggregate({
    where: { userId },
    _sum: { changeAmount: true },
  });
  return agg._sum.changeAmount ?? 0n;
}

async function assertConserved(userId: number, expected: bigint) {
  const balance = await getBalance(userId);
  expect(balance).toBe(expected);
  // 账目守恒：所有流水变动量之和 == 有效 grant 剩余之和
  expect(await ledgerSum(userId)).toBe(balance);
}

afterAll(async () => {
  await db.$disconnect();
});

describe("refund 并发原子性（L5）", () => {
  it("同一 requestId 并发退款 10 次：只入账一次，不产生重复流水", async () => {
    const uid = await freshUser(1000n);
    const rid = `l5-same-${Date.now()}`;
    expect((await consume(uid, 100n, rid, rid)).ok).toBe(true);
    expect(await getBalance(uid)).toBe(900n);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => refund(uid, 100n, rid, `${rid}:refund`))
    );
    expect(results.every((r) => r.ok)).toBe(true);

    await assertConserved(uid, 1000n);
    const rows = await db.creditLedger.findMany({ where: { requestId: `${rid}:refund` } });
    expect(rows.length).toBe(1); // 唯一流水，没有重复退款
  });

  it("不同 requestId 并发退款 10 笔：不丢更新（旧实现会只生效一笔）", async () => {
    const uid = await freshUser(10000n);
    const stamp = Date.now();
    for (let i = 0; i < 10; i++) {
      const rid = `l5-multi-${stamp}-${i}`;
      expect((await consume(uid, 100n, rid, rid)).ok).toBe(true);
    }
    expect(await getBalance(uid)).toBe(9000n);

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const rid = `l5-multi-${stamp}-${i}`;
        return refund(uid, 100n, rid, `${rid}:refund`);
      })
    );

    await assertConserved(uid, 10000n);
    const rows = await db.creditLedger.findMany({
      where: { userId: uid, reason: "refund" },
    });
    expect(rows.length).toBe(10);
  });

  it("退款 × 消费交叉：退款不会覆盖并发消费的扣减", async () => {
    const uid = await freshUser(1000n);
    const stamp = Date.now();
    const refundRid = `l5-cross-r-${stamp}`;
    expect((await consume(uid, 100n, refundRid, refundRid)).ok).toBe(true);
    expect(await getBalance(uid)).toBe(900n);

    // 同时：1 笔退款(+100) 与 5 笔消费(-10)
    const consumeIds = Array.from({ length: 5 }, (_, i) => `l5-cross-c-${stamp}-${i}`);
    await Promise.all([
      refund(uid, 100n, refundRid, `${refundRid}:refund`),
      ...consumeIds.map((rid) => consume(uid, 10n, rid, rid)),
    ]);

    // 线性化结果唯一：1000 - 100 + 100 - 5×10 = 950
    await assertConserved(uid, 950n);
  });

  it("只要 sum(流水) 与余额一致，重复执行整组操作也不会漂移", async () => {
    const uid = await freshUser(500n);
    const stamp = Date.now();
    const a = `l5-conserve-a-${stamp}`;
    const b = `l5-conserve-b-${stamp}`;
    expect((await consume(uid, 50n, a, a)).ok).toBe(true);
    expect((await consume(uid, 70n, b, b)).ok).toBe(true);
    // 重复触发（幂等）
    await Promise.all([
      refund(uid, 50n, a, `${a}:refund`),
      refund(uid, 50n, a, `${a}:refund`),
      refund(uid, 70n, b, `${b}:refund`),
    ]);
    await assertConserved(uid, 500n);
  });
});
