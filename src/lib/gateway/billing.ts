// ─── P2 会员积分闭环：真实计费接入（替换 P1 占位） ───
//
// 计费语义（方案 6.1）：
//   preCheck   —— 余额门槛（<200 分禁生图/生视频）+ 余额 ≥ 预估积分
//   preDeduct  —— consume(est) 预扣，requestId 幂等
//   settle     —— 实际 ≤ 预估退差额；实际 > 预估补扣，总扣分封顶 est×3
//   refund     —— 上游最终失败全额整数退回
// 实扣积分按实际用量 ceil 后由路由写入 usage_record.paid_credits
// （内部成本毫积分写 cost_milli），见 src/lib/gateway/usage.ts。

import { db } from "@/lib/db";
import { consume, refund as creditRefund, getBalance } from "@/lib/credits";
import { recordBillingFailure } from "./billing-reconcile";

export type EndpointType = "chat" | "image" | "video" | "audio";

export interface BillingHooks {
  preCheck(
    userId: number,
    estCredits: number,
    endpointType: EndpointType
  ): Promise<{ ok: boolean; error?: string }>;
  preDeduct(userId: number, estCredits: number, requestId: string): Promise<{ ok: boolean; error?: string }>;
  settle(userId: number, requestId: string, actualCredits: number): Promise<void>;
  refund(userId: number, requestId: string): Promise<void>;
}

// P1 占位实现：预检/预扣直接 ok，结算/退款空操作（保留供测试对比）
export const placeholderBilling: BillingHooks = {
  async preCheck(userId, estCredits) {
    console.log(`[billing:P1占位] preCheck user=${userId} estCredits=${estCredits}`);
    return { ok: true };
  },
  async preDeduct(userId, estCredits, requestId) {
    console.log(`[billing:P1占位] preDeduct user=${userId} estCredits=${estCredits} requestId=${requestId}`);
    return { ok: true };
  },
  async settle(userId, requestId, actualCredits) {
    console.log(`[billing:P1占位] settle user=${userId} requestId=${requestId} actualCredits=${actualCredits}`);
  },
  async refund(userId, requestId) {
    console.log(`[billing:P1占位] refund user=${userId} requestId=${requestId}`);
  },
};

// 生图/生视频最低余额门槛（积分）
const MEDIA_MIN_BALANCE = 200n;
// 补扣封顶：总扣分 ≤ est×3（防估算偏差跑飞）
const SETTLE_CAP_MULT = 3n;

// 本次请求已预扣的积分（consume 流水 requestId=requestId）
async function deductedOf(requestId: string): Promise<bigint> {
  const row = await db.creditLedger.findUnique({ where: { requestId } });
  return row && row.changeAmount < 0n ? -row.changeAmount : 0n;
}

export const creditBilling: BillingHooks = {
  async preCheck(userId, estCredits, endpointType) {
    const balance = await getBalance(userId);
    if ((endpointType === "image" || endpointType === "video") && balance < MEDIA_MIN_BALANCE) {
      return { ok: false, error: "Insufficient credits: image/video generation requires at least 200 credits" };
    }
    if (balance < BigInt(Math.max(0, Math.ceil(estCredits)))) {
      return { ok: false, error: "Insufficient credits" };
    }
    return { ok: true };
  },

  async preDeduct(userId, estCredits, requestId) {
    const est = BigInt(Math.max(0, Math.ceil(estCredits)));
    const r = await consume(userId, est, requestId, requestId);
    return r.ok ? { ok: true } : { ok: false, error: "Insufficient credits" };
  },

  async settle(userId, requestId, actualCredits) {
    const est = await deductedOf(requestId);
    const actual = BigInt(Math.max(0, Math.ceil(actualCredits)));
    const settleId = `${requestId}:settle`;
    try {
      if (actual <= est) {
        const diff = est - actual;
        if (diff > 0n) await creditRefund(userId, diff, requestId, settleId);
        return;
      }
      let supplement = actual - est;
      const cap = est * SETTLE_CAP_MULT;
      if (est + supplement > cap) supplement = cap - est;
      if (supplement <= 0n) return;
      const r = await consume(userId, supplement, requestId, settleId);
      if (!r.ok) {
        // 余额不足以补扣全差额：按可用余额尽量补扣，不把余额打穿
        const balance = await getBalance(userId);
        const partial = balance < supplement ? balance : supplement;
        if (partial > 0n) await consume(userId, partial, requestId, settleId);
      }
    } catch (e) {
      // S0-3：失败落库（幂等），由 billing-reconcile 循环重试，不静默丢账
      console.error(`[billing] settle 失败 requestId=${requestId}`, e);
      await recordBillingFailure({ userId, requestId, kind: "settle", amount: actual, error: e });
    }
  },

  async refund(userId, requestId) {
    try {
      const est = await deductedOf(requestId);
      if (est > 0n) await creditRefund(userId, est, requestId, `${requestId}:refund`);
    } catch (e) {
      // S0-3：失败落库（幂等），由 billing-reconcile 循环重试，不静默丢账
      console.error(`[billing] refund 失败 requestId=${requestId}`, e);
      await recordBillingFailure({ userId, requestId, kind: "refund", amount: 0n, error: e });
    }
  },
};

// 当前计费实现（真实积分）
export const billing: BillingHooks = creditBilling;
