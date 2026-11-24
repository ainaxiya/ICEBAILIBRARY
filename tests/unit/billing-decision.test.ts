import { describe, it, expect, afterAll } from "vitest";
import { db } from "@/lib/db";
import { creditBilling } from "@/lib/gateway/billing";
import { grant, getBalance } from "@/lib/credits";
import { failStaleVideoTask } from "@/lib/gateway/video-task";

// ─── L4 / L3 回归（直连 prompthub_test）───
// L4：一次预扣只能由「结算」或「退款」其一收口，杜绝「结算差额 + 全额退款」双退。
// L3：卡死 processing 任务在状态转移处真正退款，与接口文案一致。

let seq = 0;
async function freshUser(credits: bigint): Promise<number> {
  const user = await db.user.create({
    data: {
      username: `unit-l4-${Date.now()}-${++seq}`,
      passwordHash: "x",
      status: "active",
    },
  });
  await grant(user.id, "trial", credits, `unit-l4-fixture-${user.id}`);
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
  expect(await ledgerSum(userId)).toBe(balance);
}

function rid(tag: string): string {
  return `l4-${tag}-${Date.now()}-${++seq}`;
}

afterAll(async () => {
  await db.$disconnect();
});

describe("结算 / 退款互斥（L4）", () => {
  it("已结算后再退款：拒绝全额退款（不再出现差额 + 全退双退）", async () => {
    const uid = await freshUser(1000n);
    const r = rid("settled");
    expect((await creditBilling.preDeduct(uid, 100, r)).ok).toBe(true);
    await creditBilling.settle(uid, r, 80); // 退差额 20
    expect(await getBalance(uid)).toBe(920n);
    expect(await db.creditLedger.findUnique({ where: { requestId: `${r}:settle` } })).not.toBeNull();

    await creditBilling.refund(uid, r); // 任务随后抛异常触发退款

    await assertConserved(uid, 920n); // 旧实现会变成 1020
    expect(await db.creditLedger.findUnique({ where: { requestId: `${r}:refund` } })).toBeNull();
  });

  it("未结算退款：全额原路退回，重复调用不重复退", async () => {
    const uid = await freshUser(1000n);
    const r = rid("unsettled");
    expect((await creditBilling.preDeduct(uid, 100, r)).ok).toBe(true);
    expect(await getBalance(uid)).toBe(900n);

    await creditBilling.refund(uid, r);
    await creditBilling.refund(uid, r); // 重放
    await assertConserved(uid, 1000n);

    const rows = await db.creditLedger.findMany({ where: { requestId: `${r}:refund` } });
    expect(rows.length).toBe(1);
  });

  it("重复结算（退差额路径）：只退一次", async () => {
    const uid = await freshUser(1000n);
    const r = rid("dup-diff");
    expect((await creditBilling.preDeduct(uid, 100, r)).ok).toBe(true);
    await creditBilling.settle(uid, r, 80);
    await creditBilling.settle(uid, r, 80);
    await assertConserved(uid, 920n);
    expect(await db.creditLedger.findMany({ where: { requestId: `${r}:settle` } })).toHaveLength(1);
  });

  it("重复结算（补扣路径）：只补一次", async () => {
    const uid = await freshUser(1000n);
    const r = rid("dup-supplement");
    expect((await creditBilling.preDeduct(uid, 100, r)).ok).toBe(true);
    await creditBilling.settle(uid, r, 150); // 补扣 50
    await creditBilling.settle(uid, r, 150);
    await assertConserved(uid, 850n);
    expect(await db.creditLedger.findMany({ where: { requestId: `${r}:settle` } })).toHaveLength(1);
  });

  it("零差额结算（actual == est）已被决策收口，后续退款被拒", async () => {
    const uid = await freshUser(1000n);
    const r = rid("zero-diff");
    expect((await creditBilling.preDeduct(uid, 100, r)).ok).toBe(true);
    await creditBilling.settle(uid, r, 100);
    await creditBilling.refund(uid, r);
    await assertConserved(uid, 900n);
    const decision = await db.creditLedger.findUnique({ where: { requestId: `${r}:decision` } });
    expect(decision?.refId).toBe("settle");
  });

  it("结算与退款并发：只发生一个，绝不双退", async () => {
    const uid = await freshUser(3000n);
    const stamp = Date.now();
    for (let i = 0; i < 10; i++) {
      const r = `l4-race-${stamp}-${i}`;
      const before = await getBalance(uid);
      expect((await creditBilling.preDeduct(uid, 100, r)).ok).toBe(true);
      await Promise.all([
        creditBilling.settle(uid, r, 80), // 若胜出：净扣 80
        creditBilling.refund(uid, r), // 若胜出：净扣 0
      ]);
      const charged = before - (await getBalance(uid));
      // 结果必须是二者之一；旧实现可能出现 20（双退，用户倒赚）
      expect([0n, 80n]).toContain(charged);
      const decision = await db.creditLedger.findUnique({ where: { requestId: `${r}:decision` } });
      expect(["settle", "refund"]).toContain(decision?.refId);
    }
    expect(await ledgerSum(uid)).toBe(await getBalance(uid));
  });
});

describe("g19 未预扣任务结算（按实际消费扣）", () => {
  it("无预扣：成功结算按实际扣一次，重放不重复扣，且不写决策行/退款行", async () => {
    const uid = await freshUser(1000n);
    const r = rid("no-hold");

    await creditBilling.settle(uid, r, 21);
    expect(await getBalance(uid)).toBe(979n);
    await creditBilling.settle(uid, r, 21); // 并发/重放
    expect(await getBalance(uid)).toBe(979n);

    expect(await db.creditLedger.findUnique({ where: { requestId: `${r}:settle` } })).not.toBeNull();
    expect(await db.creditLedger.findMany({ where: { requestId: `${r}:decision` } })).toHaveLength(0);
    expect(await db.creditLedger.findMany({ where: { requestId: `${r}:refund` } })).toHaveLength(0);

    // 失败路径兜底退款：没有预扣就不应退款、也不应产生流水
    await creditBilling.refund(uid, r);
    expect(await getBalance(uid)).toBe(979n);
    expect(await db.creditLedger.findMany({ where: { requestId: `${r}:refund` } })).toHaveLength(0);

    await assertConserved(uid, 979n);
  });

  it("无预扣 + apiKeyId：实际消费与 Key usedCredits 同事务累加，重放不重复", async () => {
    const uid = await freshUser(1000n);
    const key = await db.userApiKey.create({
      data: {
        userId: uid,
        keyPrefix: "sk-unit",
        keyHash: `hash-${Date.now()}-${++seq}`,
        quotaCredits: 500,
      },
    });
    const r = rid("no-hold-key");

    await creditBilling.settle(uid, r, 21, key.id);
    await creditBilling.settle(uid, r, 21, key.id);

    expect(await getBalance(uid)).toBe(979n);
    const after = await db.userApiKey.findUnique({ where: { id: key.id }, select: { usedCredits: true } });
    expect(after?.usedCredits).toBe(21n);
    // 后付费的额度标记按结算流水号（requestId:settle）记录，避免与预占行冲突
    expect(await db.apiKeyQuotaHold.findMany({ where: { requestId: `${r}:settle` } })).toHaveLength(1);
    await assertConserved(uid, 979n);
  });
});

describe("卡死任务退款口径（L3）", () => {
  async function createProcessingTask(uid: number, requestId: string) {
    const taskId = `vt-unit-${Date.now()}-${++seq}`;
    await db.videoTask.create({
      data: {
        taskId,
        requestId,
        userId: uid,
        channel: "apikey",
        modelId: 1,
        modelSnapshot: "unit-model",
        status: "processing",
        progress: 30,
        payload: "{}",
      },
    });
    return taskId;
  }

  it("超过阈值：原子改 failed 并真正退款，重复调用幂等", async () => {
    const uid = await freshUser(1000n);
    const r = rid("stale");
    expect((await creditBilling.preDeduct(uid, 100, r)).ok).toBe(true);
    const taskId = await createProcessingTask(uid, r);

    // 把「当前时间」前移 46 分钟，模拟任务卡死超过阈值（STALE_PROCESSING_MS=45min；不依赖数据库时区）
    const realNow = Date.now;
    Date.now = () => realNow() + 46 * 60_000;
    try {
      expect(await failStaleVideoTask({ taskId, userId: uid, requestId: r })).toBe(true);
    } finally {
      Date.now = realNow;
    }
    const task = await db.videoTask.findUnique({ where: { taskId } });
    expect(task?.status).toBe("failed");
    await assertConserved(uid, 1000n);

    // 第二次轮询：任务已不是 processing → 不改账、不重复退款
    expect(await failStaleVideoTask({ taskId, userId: uid, requestId: r })).toBe(false);
    await assertConserved(uid, 1000n);
  });

  it("未超阈值：不改状态、不退款（不误伤仍在执行的任务）", async () => {
    const uid = await freshUser(1000n);
    const r = rid("fresh");
    expect((await creditBilling.preDeduct(uid, 100, r)).ok).toBe(true);
    const taskId = await createProcessingTask(uid, r);

    expect(await failStaleVideoTask({ taskId, userId: uid, requestId: r })).toBe(false);
    const task = await db.videoTask.findUnique({ where: { taskId } });
    expect(task?.status).toBe("processing");
    await assertConserved(uid, 900n);
  });
});
