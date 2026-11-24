import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

// ─── P2 会员积分服务（方案第 4 章） ───
// 全部 BigInt 整数积分，永不小数。
// 余额真源 = credit_grant 中有效（未过期）grant 的 remainingCredits 求和；
// credit_ledger 只增流水，requestId 幂等（唯一索引冲突则跳过写入）。

export type GrantType = "subscription" | "topup" | "gift" | "trial";
export type LedgerReason = "grant" | "consume" | "refund" | "admin_adjust";

type Tx = Prisma.TransactionClient;

// 有效 grant 条件：剩余 > 0 且未过期
function validGrantWhere(userId: number): Prisma.CreditGrantWhereInput {
  return {
    userId,
    remainingCredits: { gt: 0 },
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  };
}

// 余额 = 有效 grant 剩余之和
async function sumRemaining(client: Tx | typeof db, userId: number): Promise<bigint> {
  const agg = await client.creditGrant.aggregate({
    where: validGrantWhere(userId),
    _sum: { remainingCredits: true },
  });
  return agg._sum.remainingCredits ?? 0n;
}

// 写流水（requestId 幂等：唯一索引冲突则跳过）
async function writeLedger(
  tx: Tx,
  data: {
    userId: number;
    changeAmount: bigint;
    balanceAfter: bigint;
    reason: LedgerReason;
    refType?: string | null;
    refId?: string | null;
    requestId?: string | null;
  }
): Promise<boolean> {
  try {
    await tx.creditLedger.create({
      data: {
        userId: data.userId,
        changeAmount: data.changeAmount,
        balanceAfter: data.balanceAfter,
        reason: data.reason,
        refType: data.refType ?? null,
        refId: data.refId ?? null,
        requestId: data.requestId ?? null,
      },
    });
    return true;
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return false; // requestId 已写过 → 幂等跳过
    throw e;
  }
}

// requestId 事务级串行锁：PostgreSQL advisory lock，随事务提交/回滚自动释放。
// 同一 requestId 的并发结算/退款先在数据库层排队，再做幂等检查，
// 避免两个事务都读到「流水不存在」而各自入账（唯一索引只能挡住流水，挡不住余额变动）。
async function lockLedgerRequest(tx: Tx, requestId: string): Promise<void> {
  // 用 $executeRaw 调用：$queryRaw 无法反序列化 void 返回列
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('credit_ledger'), hashtext(${requestId}))`;
}

// ─── 查询余额 ───
export async function getBalance(userId: number): Promise<bigint> {
  return sumRemaining(db, userId);
}

// ─── 授予积分（幂等：UNIQUE(userId, grantType, sourceRef) 冲突则跳过） ───
export async function grant(
  userId: number,
  grantType: GrantType,
  totalCredits: bigint,
  sourceRef: string,
  expiresAt?: Date | null
): Promise<{ ok: boolean; already?: boolean; grantId?: number }> {
  if (totalCredits <= 0n) return { ok: true, already: true };
  return db.$transaction(async (tx) => {
    const existing = await tx.creditGrant.findUnique({
      where: { userId_grantType_sourceRef: { userId, grantType, sourceRef } },
    });
    if (existing) return { ok: true, already: true, grantId: existing.id };
    const g = await tx.creditGrant.create({
      data: {
        userId,
        grantType,
        totalCredits,
        remainingCredits: totalCredits,
        expiresAt: expiresAt ?? null,
        sourceRef,
      },
    });
    const balanceAfter = await sumRemaining(tx, userId);
    await writeLedger(tx, {
      userId,
      changeAmount: totalCredits,
      balanceAfter,
      reason: "grant",
      refType: "credit_grant",
      refId: String(g.id),
      requestId: `grant:${userId}:${grantType}:${sourceRef}`,
    });
    return { ok: true, grantId: g.id };
  });
}

// ─── 消费扣减（事务 + 行锁；按 expiresAt NULLS LAST 先过期先扣，可跨多个 grant） ───
// 不足返回 ok=false（不动任何 grant）；requestId 幂等：已扣过直接返回 ok
export async function consume(
  userId: number,
  amount: bigint,
  refId: string,
  requestId: string,
  // g19：后付费路径传 apiKeyId，在同一事务内累加 Key 已用额度（hold 行作为幂等标记）
  apiKeyIdForQuota?: number | null
): Promise<{ ok: boolean; already?: boolean; balanceAfter?: bigint; error?: string }> {
  if (amount < 0n) return { ok: false, error: "amount 必须为非负整数" };
  return db.$transaction(async (tx) => {
    // 同一 requestId 串行化：并发重放只会有一次真正扣减
    await lockLedgerRequest(tx, requestId);
    if (await tx.creditLedger.findUnique({ where: { requestId } })) {
      return { ok: true, already: true };
    }
    if (amount === 0n) {
      // 0 分消费（免费模型）不落流水：没有真实积分变动，写 0 行只会污染「积分明细」。
      // 幂等仍由上面的 requestId 锁保证；退款侧按 deductedOf=0 直接跳过。
      const bal = await sumRemaining(tx, userId);
      return { ok: true, balanceAfter: bal };
    }
    // 行锁串行化并发扣减；id 作为同过期时间的稳定次序，保证与 refund 的加锁顺序一致（防死锁）
    const locked = await tx.$queryRaw<
      { id: number; remaining: bigint }[]
    >`SELECT id, "remainingCredits" AS remaining FROM credit_grant WHERE "userId" = ${userId} AND "remainingCredits" > 0 AND ("expiresAt" IS NULL OR "expiresAt" > now()) ORDER BY "expiresAt" ASC NULLS LAST, id ASC FOR UPDATE`;
    const balance = locked.reduce((s, r) => s + BigInt(r.remaining), 0n);
    if (balance < amount) {
      return { ok: false, error: "积分不足" };
    }
    let left = amount;
    for (const g of locked) {
      if (left <= 0n) break;
      const rem = BigInt(g.remaining);
      const take = rem < left ? rem : left;
      await tx.creditGrant.update({
        where: { id: g.id },
        data: { remainingCredits: rem - take },
      });
      left -= take;
    }
    const balanceAfter = balance - amount;
    await writeLedger(tx, {
      userId,
      changeAmount: -amount,
      balanceAfter,
      reason: "consume",
      refType: "request",
      refId,
      requestId,
    });
    // g19：无预扣后付费时，Key 已用额度与实际扣分同事务累加；
    // hold 行只作为「本次 requestId 已记账」的幂等标记，不会在退款时释放（无预扣可退）。
    if (apiKeyIdForQuota != null) {
      const marked = await tx.apiKeyQuotaHold.findUnique({ where: { requestId } });
      if (!marked) {
        await tx.$executeRaw`UPDATE user_api_key SET "usedCredits" = "usedCredits" + ${amount} WHERE id = ${apiKeyIdForQuota}`;
        await tx.apiKeyQuotaHold.create({
          data: { requestId, apiKeyId: apiKeyIdForQuota, amount: Number(amount) },
        });
      }
    }
    return { ok: true, balanceAfter };
  });
}

// ─── 整数退回（优先回填曾扣减的有效 grant，剩余建 gift grant） ───
// L5：回填必须走数据库行锁，不能在应用层「读旧值 + 写回」：
//   ① 并发退款：两个事务都读到同一 remaining，各自 +add 写回 → 丢更新（少退）；
//   ② 退款 × 消费：consume 已锁行扣减，退款用锁前旧值覆盖 → 把扣减抹掉（多退）。
// 这里用 SELECT ... FOR UPDATE 锁住候选 grant，加锁顺序与 consume 完全一致
// （expiresAt ASC NULLS LAST, id ASC），并发事务在数据库层排队，不会死锁也不会丢更新。
export async function refund(
  userId: number,
  amount: bigint,
  refId: string,
  requestId: string
): Promise<{ ok: boolean; already?: boolean }> {
  if (amount <= 0n) return { ok: true, already: true };
  return db.$transaction(async (tx) => {
    // 同一 requestId 串行化：并发重放只会有一次真正入账
    await lockLedgerRequest(tx, requestId);
    if (await tx.creditLedger.findUnique({ where: { requestId } })) {
      return { ok: true, already: true };
    }
    let left = amount;
    // 回填：仍有效且曾被扣减（remaining < total）的 grant；锁定后按锁内最新值计算
    const candidates = await tx.$queryRaw<
      { id: number; remaining: bigint; total: bigint }[]
    >`SELECT id, "remainingCredits" AS remaining, "totalCredits" AS total FROM credit_grant WHERE "userId" = ${userId} AND ("expiresAt" IS NULL OR "expiresAt" > now()) ORDER BY "expiresAt" ASC NULLS LAST, id ASC LIMIT 20 FOR UPDATE`;
    for (const g of candidates) {
      if (left <= 0n) break;
      const remaining = BigInt(g.remaining);
      const gap = BigInt(g.total) - remaining;
      if (gap <= 0n) continue;
      const add = gap < left ? gap : left;
      await tx.creditGrant.update({
        where: { id: g.id },
        data: { remainingCredits: remaining + add },
      });
      left -= add;
    }
    if (left > 0n) {
      await tx.creditGrant.create({
        data: {
          userId,
          grantType: "gift",
          totalCredits: left,
          remainingCredits: left,
          expiresAt: null,
          sourceRef: `refund:${requestId}`,
        },
      });
    }
    const balanceAfter = await sumRemaining(tx, userId);
    await writeLedger(tx, {
      userId,
      changeAmount: amount,
      balanceAfter,
      reason: "refund",
      refType: "request",
      refId,
      requestId,
    });
    return { ok: true };
  });
}

// ─── 管理员手工调账（正=入账 gift grant，负=按先过期先扣减） ───
export async function adminAdjust(
  userId: number,
  amount: bigint,
  note: string,
  requestId: string
): Promise<{ ok: boolean; already?: boolean; error?: string }> {
  if (amount === 0n) return { ok: true, already: true };
  return db.$transaction(async (tx) => {
    await lockLedgerRequest(tx, requestId);
    if (await tx.creditLedger.findUnique({ where: { requestId } })) {
      return { ok: true, already: true };
    }
    if (amount > 0n) {
      await tx.creditGrant.create({
        data: {
          userId,
          grantType: "gift",
          totalCredits: amount,
          remainingCredits: amount,
          expiresAt: null,
          sourceRef: `adjust:${requestId}`,
        },
      });
    } else {
      const need = -amount;
      const locked = await tx.$queryRaw<
        { id: number; remaining: bigint }[]
      >`SELECT id, "remainingCredits" AS remaining FROM credit_grant WHERE "userId" = ${userId} AND "remainingCredits" > 0 AND ("expiresAt" IS NULL OR "expiresAt" > now()) ORDER BY "expiresAt" ASC NULLS LAST, id ASC FOR UPDATE`;
      const balance = locked.reduce((s, r) => s + BigInt(r.remaining), 0n);
      if (balance < need) return { ok: false, error: "积分不足，无法扣减" };
      let left = need;
      for (const g of locked) {
        if (left <= 0n) break;
        const rem = BigInt(g.remaining);
        const take = rem < left ? rem : left;
        await tx.creditGrant.update({
          where: { id: g.id },
          data: { remainingCredits: rem - take },
        });
        left -= take;
      }
    }
    const balanceAfter = await sumRemaining(tx, userId);
    await writeLedger(tx, {
      userId,
      changeAmount: amount,
      balanceAfter,
      reason: "admin_adjust",
      refType: "admin",
      refId: note,
      requestId,
    });
    return { ok: true };
  });
}

// ─── 后台额度调整三模式（b12）：增加 / 扣减 / 覆盖 ───
// 覆盖（set）用目标余额反算差额，仅超管可用；差额为 0 也写一条 0 变动流水，备注不丢。
export type AdminAdjustMode = "increase" | "deduct" | "set";

export interface AdjustPreview {
  ok: boolean;
  delta: bigint;
  after: bigint;
  error?: string;
}

// 纯函数：前后台共用的调整预览（increase / deduct 要求正数，set 允许 0 与任意非负整数）
export function previewAdjustment(balance: bigint, mode: AdminAdjustMode, amount: bigint): AdjustPreview {
  if (amount < 0n) return { ok: false, delta: 0n, after: balance, error: "调整数量必须为非负整数" };
  if (mode !== "set" && amount === 0n) {
    return { ok: false, delta: 0n, after: balance, error: "调整数量不能为 0" };
  }
  const delta = mode === "increase" ? amount : mode === "deduct" ? -amount : amount - balance;
  const after = balance + delta;
  if (after < 0n) return { ok: false, delta, after, error: "扣减后余额不能为负" };
  return { ok: true, delta, after };
}

// 覆盖为目标余额：锁内重算余额 → 差额入账/扣减 → 写 admin_adjust 流水
export async function adminSetBalance(
  userId: number,
  target: bigint,
  note: string,
  requestId: string
): Promise<{ ok: boolean; already?: boolean; before?: bigint; after?: bigint; error?: string }> {
  if (target < 0n) return { ok: false, error: "目标余额必须为非负整数" };
  return db.$transaction(async (tx) => {
    await lockLedgerRequest(tx, requestId);
    if (await tx.creditLedger.findUnique({ where: { requestId } })) {
      return { ok: true, already: true };
    }
    // 锁住有效 grant 后重算，避免与并发消费/退款交错
    const locked = await tx.$queryRaw<
      { id: number; remaining: bigint }[]
    >`SELECT id, "remainingCredits" AS remaining FROM credit_grant WHERE "userId" = ${userId} AND "remainingCredits" > 0 AND ("expiresAt" IS NULL OR "expiresAt" > now()) ORDER BY "expiresAt" ASC NULLS LAST, id ASC FOR UPDATE`;
    const before = locked.reduce((s, r) => s + BigInt(r.remaining), 0n);
    const delta = target - before;

    if (delta > 0n) {
      await tx.creditGrant.create({
        data: {
          userId,
          grantType: "gift",
          totalCredits: delta,
          remainingCredits: delta,
          expiresAt: null,
          sourceRef: `adjust:${requestId}`,
        },
      });
    } else if (delta < 0n) {
      let left = -delta;
      for (const g of locked) {
        if (left <= 0n) break;
        const rem = BigInt(g.remaining);
        const take = rem < left ? rem : left;
        await tx.creditGrant.update({ where: { id: g.id }, data: { remainingCredits: rem - take } });
        left -= take;
      }
    }

    await writeLedger(tx, {
      userId,
      changeAmount: delta,
      balanceAfter: target,
      reason: "admin_adjust",
      refType: "admin",
      refId: note,
      requestId,
    });
    return { ok: true, before, after: target };
  });
}

// ─── 积分配置（SiteSetting key="credits_config"） ───
// 「注册赠送开关」后台「运营告警」页可配；默认关闭（trialEnabled=false）。
// 支付代扣签约落地后一键开。
export interface CreditsConfig {
  trialEnabled: boolean;
  trialCredits: number;
}

export async function getCreditsConfig(): Promise<CreditsConfig> {
  const row = await db.siteSetting.findUnique({ where: { key: "credits_config" } });
  const def: CreditsConfig = { trialEnabled: false, trialCredits: 0 };
  if (!row) return def;
  try {
    const parsed = JSON.parse(row.value) as Partial<CreditsConfig>;
    return {
      trialEnabled: Boolean(parsed.trialEnabled ?? def.trialEnabled),
      trialCredits: Number(parsed.trialCredits ?? def.trialCredits) || 0,
    };
  } catch {
    return def;
  }
}

// ─── 积分包种子（幂等 upsert 兜底，不覆盖后台已改字段） ───
const DEFAULT_PACKS = [
  { packCode: "p30", priceCents: 3000n, credits: 3000n, bonusCredits: 0n, sortOrder: 1 },
  { packCode: "p50", priceCents: 5000n, credits: 5000n, bonusCredits: 100n, sortOrder: 2 },
  { packCode: "p200", priceCents: 20000n, credits: 20000n, bonusCredits: 2500n, sortOrder: 3 },
];

export async function ensureCreditPacks(): Promise<void> {
  for (const p of DEFAULT_PACKS) {
    await db.creditPack.upsert({
      where: { packCode: p.packCode },
      update: {},
      create: { ...p, isActive: true },
    });
  }
}
