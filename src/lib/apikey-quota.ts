import { db } from "@/lib/db";

// ─── b2 硬额度：Key 额度读写（不含 crypto，避免被 instrumentation 打包） ───
// quotaCredits = null 表示不限额；usedCredits 为原子计数器（预占 + 结算口径）。

// 设置额度上限：ownerUserId 为空 = 后台管理员操作。
// 同时把历史用量并入 usedCredits，避免老 Key 设额度后从 0 起算。
export async function setApiKeyQuota(
  id: number,
  quotaCredits: number | null,
  ownerUserId?: number
): Promise<boolean> {
  const key = await db.userApiKey.findFirst({
    where: ownerUserId == null ? { id } : { id, userId: ownerUserId },
    select: { id: true, usedCredits: true },
  });
  if (!key) return false;
  const agg = await db.usageRecord.aggregate({
    where: { apiKeyId: BigInt(id) },
    _sum: { paidCredits: true },
  });
  const historical = agg._sum.paidCredits ?? 0n;
  await db.userApiKey.update({
    where: { id },
    data: {
      quotaCredits,
      usedCredits: key.usedCredits > historical ? key.usedCredits : historical,
    },
  });
  return true;
}

// ─── 额度只读预检（g19 后付费） ───
// 不再预占，只判断「已用 + 本次预估 ≤ 额度」；并发下可能短暂小幅超出，已作为后付费的接受代价。
export async function checkApiKeyQuota(
  apiKeyId: number,
  amount: number
): Promise<{ ok: boolean; code?: "key_quota_exceeded" }> {
  const amt = Math.max(0, Math.round(amount));
  if (amt <= 0) return { ok: true };
  const key = await db.userApiKey.findUnique({
    where: { id: apiKeyId },
    select: { quotaCredits: true, usedCredits: true },
  });
  if (!key || key.quotaCredits == null) return { ok: true };
  if (key.usedCredits + BigInt(amt) > key.quotaCredits) {
    return { ok: false, code: "key_quota_exceeded" as const };
  }
  return { ok: true };
}

// ─── 额度预占（防并发超卖） ───
// 原子条件更新：仅当「已用 + 本次预占 ≤ 额度」或「额度为 NULL（不限额）」时累加。
// 同一 requestId 重复预占幂等（唯一索引兜底，冲突时事务回滚，不重复计数）。
export async function reserveApiKeyQuota(
  apiKeyId: number,
  requestId: string,
  amount: number
): Promise<{ ok: boolean; code?: "key_quota_exceeded" }> {
  const amt = Math.max(0, Math.round(amount));
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.apiKeyQuotaHold.findUnique({ where: { requestId } });
      if (existing) return { ok: true };
      if (amt <= 0) {
        await tx.apiKeyQuotaHold.create({ data: { requestId, apiKeyId, amount: 0 } });
        return { ok: true };
      }
      const rows = await tx.$queryRaw<{ id: number }[]>`
        UPDATE user_api_key
        SET "usedCredits" = "usedCredits" + ${BigInt(amt)}
        WHERE id = ${apiKeyId}
          AND ("quotaCredits" IS NULL OR "usedCredits" + ${BigInt(amt)} <= "quotaCredits")
        RETURNING id
      `;
      if (!rows.length) return { ok: false, code: "key_quota_exceeded" as const };
      await tx.apiKeyQuotaHold.create({ data: { requestId, apiKeyId, amount: amt } });
      return { ok: true };
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return { ok: true };
    throw e;
  }
}

// 额度收口：settle 传实际积分（多退少补，补扣不超额度上限）；refund 不传 = 全额释放预占。
export async function releaseApiKeyQuota(requestId: string, actualCredits?: number): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      const hold = await tx.apiKeyQuotaHold.findUnique({ where: { requestId } });
      if (!hold) return;
      if (typeof actualCredits === "number" && Number.isFinite(actualCredits)) {
        const delta = Math.round(actualCredits) - hold.amount;
        if (delta > 0) {
          await tx.$executeRaw`
            UPDATE user_api_key
            SET "usedCredits" = LEAST(COALESCE("quotaCredits", "usedCredits" + ${BigInt(delta)}), "usedCredits" + ${BigInt(delta)})
            WHERE id = ${hold.apiKeyId}
          `;
        } else if (delta < 0) {
          await tx.$executeRaw`
            UPDATE user_api_key
            SET "usedCredits" = GREATEST(0, "usedCredits" - ${BigInt(-delta)})
            WHERE id = ${hold.apiKeyId}
          `;
        }
      } else if (hold.amount > 0) {
        await tx.$executeRaw`
          UPDATE user_api_key
          SET "usedCredits" = GREATEST(0, "usedCredits" - ${BigInt(hold.amount)})
          WHERE id = ${hold.apiKeyId}
        `;
      }
      await tx.apiKeyQuotaHold.delete({ where: { requestId } });
    });
  } catch {
    // 收口失败不影响主流程；预占将在 Key 设新额度时按历史用量校正
  }
}
