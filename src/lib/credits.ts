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
  requestId: string
): Promise<{ ok: boolean; already?: boolean; balanceAfter?: bigint; error?: string }> {
  if (amount < 0n) return { ok: false, error: "amount 必须为非负整数" };
  return db.$transaction(async (tx) => {
    if (await tx.creditLedger.findUnique({ where: { requestId } })) {
      return { ok: true, already: true };
    }
    if (amount === 0n) {
      const bal = await sumRemaining(tx, userId);
      await writeLedger(tx, {
        userId,
        changeAmount: 0n,
        balanceAfter: bal,
        reason: "consume",
        refType: "request",
        refId,
        requestId,
      });
      return { ok: true, balanceAfter: bal };
    }
    // 行锁串行化并发扣减
    const locked = await tx.$queryRaw<
      { id: number; remaining: bigint }[]
    >`SELECT id, "remainingCredits" AS remaining FROM credit_grant WHERE "userId" = ${userId} AND "remainingCredits" > 0 AND ("expiresAt" IS NULL OR "expiresAt" > now()) ORDER BY "expiresAt" ASC NULLS LAST FOR UPDATE`;
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
    return { ok: true, balanceAfter };
  });
}

// ─── 整数退回（优先回填曾扣减的有效 grant，剩余建 gift grant） ───
export async function refund(
  userId: number,
  amount: bigint,
  refId: string,
  requestId: string
): Promise<{ ok: boolean; already?: boolean }> {
  if (amount <= 0n) return { ok: true, already: true };
  return db.$transaction(async (tx) => {
    if (await tx.creditLedger.findUnique({ where: { requestId } })) {
      return { ok: true, already: true };
    }
    let left = amount;
    // 回填：最近扣减过（remaining < total）且仍有效的 grant 优先
    const candidates = await tx.creditGrant.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });
    for (const g of candidates) {
      if (left <= 0n) break;
      if (g.expiresAt && g.expiresAt.getTime() <= Date.now()) continue;
      const gap = g.totalCredits - g.remainingCredits;
      if (gap <= 0n) continue;
      const add = gap < left ? gap : left;
      await tx.creditGrant.update({
        where: { id: g.id },
        data: { remainingCredits: g.remainingCredits + add },
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
      >`SELECT id, "remainingCredits" AS remaining FROM credit_grant WHERE "userId" = ${userId} AND "remainingCredits" > 0 AND ("expiresAt" IS NULL OR "expiresAt" > now()) ORDER BY "expiresAt" ASC NULLS LAST FOR UPDATE`;
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
