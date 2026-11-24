import { describe, it, expect, afterAll } from "vitest";
import { db } from "@/lib/db";
import { creditBilling } from "@/lib/gateway/billing";
import { grant, getBalance } from "@/lib/credits";

// ─── 资金守恒：Σ(credit_ledger.changeAmount) === getBalance() ───
// 覆盖本轮三条改动：
//   ① 等待阶段断连「已发上游」→ 只结算输入部分（差额退回）
//   ② 等待阶段断连「未发上游」→ 全额退回
//   ③ v1/videos 建任务失败 → 全额退回，且同 requestId 重放不二次退款

let seq = 0;

async function freshUser(credits: bigint): Promise<number> {
  const user = await db.user.create({
    data: {
      username: `unit-conserve-${Date.now()}-${++seq}`,
      passwordHash: "x",
      status: "active",
    },
  });
  await grant(user.id, "trial", credits, `unit-conserve-fixture-${user.id}`);
  return user.id;
}

async function ledgerSum(userId: number): Promise<bigint> {
  const agg = await db.creditLedger.aggregate({ where: { userId }, _sum: { changeAmount: true } });
  return agg._sum.changeAmount ?? 0n;
}

async function assertConserved(userId: number, expected: bigint) {
  const balance = await getBalance(userId);
  expect(balance).toBe(expected);
  expect(await ledgerSum(userId)).toBe(balance);
}

function rid(tag: string): string {
  return `conserve-${tag}-${Date.now()}-${++seq}`;
}

afterAll(async () => {
  await db.$disconnect();
});

describe("断连 / 失败回滚的资金守恒", () => {
  it("断连（已发上游）：只收输入 3 分，预扣 100 的差额退回", async () => {
    const uid = await freshUser(1000n);
    const r = rid("abort-sent");
    expect((await creditBilling.preDeduct(uid, 100, r)).ok).toBe(true);
    expect(await getBalance(uid)).toBe(900n);

    await creditBilling.settle(uid, r, 3);

    await assertConserved(uid, 997n);
    // 再补一刀退款也不能生效（决策已收口为 settle）
    await creditBilling.refund(uid, r);
    await assertConserved(uid, 997n);
  });

  it("断连（未发上游）：全额退回，净扣 0", async () => {
    const uid = await freshUser(1000n);
    const r = rid("abort-unsent");
    expect((await creditBilling.preDeduct(uid, 100, r)).ok).toBe(true);

    await creditBilling.refund(uid, r);

    await assertConserved(uid, 1000n);
  });

  it("建任务失败回滚：全额退回，重放不二次退款", async () => {
    const uid = await freshUser(1000n);
    const r = rid("create-fail");
    expect((await creditBilling.preDeduct(uid, 100, r)).ok).toBe(true);

    await creditBilling.refund(uid, r); // 建任务失败
    await creditBilling.refund(uid, r); // 同一 requestId 被重放
    await creditBilling.settle(uid, r, 100); // 重放若走到结算也必须被拒

    await assertConserved(uid, 1000n);
    expect(await db.creditLedger.findMany({ where: { requestId: `${r}:refund` } })).toHaveLength(1);
    const decision = await db.creditLedger.findUnique({ where: { requestId: `${r}:decision` } });
    expect(decision?.refId).toBe("refund");
  });
});
