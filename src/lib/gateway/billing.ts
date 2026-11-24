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
import { checkApiKeyQuota, releaseApiKeyQuota, reserveApiKeyQuota } from "@/lib/apikey-quota";
import { recordBillingFailure } from "./billing-reconcile";

export type EndpointType = "chat" | "embedding" | "audio" | "image" | "video";

// 预检失败原因：insufficient_credits=余额不够本次消耗；min_balance_required=不满足该模型系列的准入余额
export type PreCheckCode = "insufficient_credits" | "min_balance_required" | "key_quota_exceeded";

export interface PreCheckResult {
  ok: boolean;
  error?: string;
  code?: PreCheckCode;
  // min_balance_required 时回传，供前端/接口返回展示
  required?: number;
  balance?: number;
}

export interface BillingHooks {
  preCheck(
    userId: number,
    estCredits: number,
    endpointType: EndpointType,
    // 模型系列准入余额（积分）；0/缺省 = 不限。由 credits-gate.minBalanceCreditsFor 计算
    minBalanceCredits?: number,
    // g19：有 API Key 时顺带只读检查额度（不预占）；超额在请求上游之前拒绝
    apiKeyId?: number | null
  ): Promise<PreCheckResult>;
  // b2：apiKeyId 非空时同时预占 Key 额度；超额返回 key_quota_exceeded（不扣分）
  preDeduct(
    userId: number,
    estCredits: number,
    requestId: string,
    apiKeyId?: number | null
  ): Promise<{ ok: boolean; error?: string; code?: "insufficient_credits" | "key_quota_exceeded" }>;
  // g19：第 4 参 apiKeyId 用于「无预扣后付费」在同一事务内累加 Key 已用额度
  settle(
    userId: number,
    requestId: string,
    actualCredits: number,
    apiKeyId?: number | null
  ): Promise<void>;
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

// 积分不足时引导充值的回跳地址（与 /login?next= 同一套约定）
export function rechargeUrlFor(nextPath: string): string {
  return `/recharge?next=${encodeURIComponent(nextPath)}`;
}

// 本次请求已预扣的积分（consume 流水 requestId=requestId）
async function deductedOf(requestId: string): Promise<bigint> {
  const row = await db.creditLedger.findUnique({ where: { requestId } });
  return row && row.changeAmount < 0n ? -row.changeAmount : 0n;
}

// L4：一次预扣只能由「结算」或「退款」其一收口。
// 用 credit_ledger 的唯一 requestId 做数据库层原子决策（不是应用层 if）：
// 先写入 `${requestId}:decision` 的一方获胜；另一方撞唯一索引（P2002）后回读，
// 看到对方已决策就放弃自己的资金动作。多进程/多实例下同样成立。
// 决策行 changeAmount=0，不改变余额；refType=billing_decision 便于审计区分。
async function claimBillingDecision(
  userId: number,
  requestId: string,
  kind: "settle" | "refund"
): Promise<"settle" | "refund" | null> {
  const decisionId = `${requestId}:decision`;
  const existing = await db.creditLedger.findUnique({ where: { requestId: decisionId } });
  if (existing) {
    return existing.refId === "settle" || existing.refId === "refund" ? existing.refId : null;
  }
  const balance = await getBalance(userId);
  try {
    await db.creditLedger.create({
      data: {
        userId,
        changeAmount: 0n,
        balanceAfter: balance,
        reason: kind === "settle" ? "consume" : "refund",
        refType: "billing_decision",
        refId: kind,
        requestId: decisionId,
      },
    });
    return kind;
  } catch (e) {
    if ((e as { code?: string })?.code !== "P2002") throw e;
    const row = await db.creditLedger.findUnique({ where: { requestId: decisionId } });
    return row?.refId === "settle" || row?.refId === "refund" ? row.refId : null;
  }
}

export const creditBilling: BillingHooks = {
  async preCheck(userId, estCredits, endpointType, minBalanceCredits = 0, apiKeyId = null) {
    const balance = await getBalance(userId);
    // 系列准入门槛优先判定：余额 1500、预估 100 的用户应拿到「门槛不足」而不是「积分不足」
    if (minBalanceCredits > 0 && balance < BigInt(minBalanceCredits)) {
      const bal = Number(balance);
      return {
        ok: false,
        code: "min_balance_required",
        required: minBalanceCredits,
        balance: bal,
        error: `This model series requires an account balance of at least ${minBalanceCredits} credits (current ${bal})`,
      };
    }
    if ((endpointType === "image" || endpointType === "video") && balance < MEDIA_MIN_BALANCE) {
      return {
        ok: false,
        code: "insufficient_credits",
        error: "Insufficient credits: image/video generation requires at least 200 credits",
      };
    }
    if (balance < BigInt(Math.max(0, Math.ceil(estCredits)))) {
      return { ok: false, code: "insufficient_credits", error: "Insufficient credits" };
    }
    // g19：Key 额度只读预检（后付费，不预占）
    if (apiKeyId != null) {
      const q = await checkApiKeyQuota(apiKeyId, estCredits);
      if (!q.ok) {
        return { ok: false, code: "key_quota_exceeded", error: "API key quota exceeded" };
      }
    }
    return { ok: true };
  },

  async preDeduct(userId, estCredits, requestId, apiKeyId) {
    const est = BigInt(Math.max(0, Math.ceil(estCredits)));
    // b2 硬额度：先原子预占 Key 额度，超额直接拒绝，不进入扣分
    if (apiKeyId != null) {
      const q = await reserveApiKeyQuota(apiKeyId, requestId, Number(est));
      if (!q.ok) {
        return { ok: false, code: "key_quota_exceeded", error: "API key quota exceeded" };
      }
    }
    const r = await consume(userId, est, requestId, requestId);
    if (!r.ok) {
      if (apiKeyId != null) await releaseApiKeyQuota(requestId);
      return { ok: false, code: "insufficient_credits", error: "Insufficient credits" };
    }
    return { ok: true };
  },

  async settle(userId, requestId, actualCredits, apiKeyId = null) {
    const actual = BigInt(Math.max(0, Math.ceil(actualCredits)));
    const settleId = `${requestId}:settle`;
    try {
      const est = await deductedOf(requestId);
      // g19：未预扣的任务（图片/文本/音频/非 seedance 视频）成功后按实际一次入账。
      // 没有预扣就不会有退款，因此不写决策行、也不产生「+0」流水；
      // settleId 唯一 + consume 内部行锁保证并发/重放只扣一次。
      if (est <= 0n) {
        if (actual > 0n) {
          const r = await consume(userId, actual, requestId, settleId, apiKeyId);
          if (!r.ok) {
            const balance = await getBalance(userId);
            const partial = balance < actual ? balance : actual;
            if (partial > 0n) await consume(userId, partial, requestId, settleId, apiKeyId);
          }
        }
        return;
      }
      // L4：已被退款收口的预扣不再结算（避免「退款 + 结算」双动作）
      const decision = await claimBillingDecision(userId, requestId, "settle");
      if (decision !== "settle") {
        console.warn(`[billing] 该预扣已退款，跳过结算 requestId=${requestId}`);
        return;
      }
      // b2：Key 额度按实际积分多退少补（补扣不超额度上限）
      await releaseApiKeyQuota(requestId, Number(actual));
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
      if (est <= 0n) return; // 没有预扣：无需退款，也不占用决策
      // L4：已被结算收口的预扣拒绝全额退款（否则「结算差额 + 全额退款」双退）
      const decision = await claimBillingDecision(userId, requestId, "refund");
      if (decision !== "refund") {
        console.warn(`[billing] 该预扣已结算，拒绝全额退款 requestId=${requestId}`);
        return;
      }
      // b2：失败退款时同步释放 Key 额度预占
      await releaseApiKeyQuota(requestId);
      await creditRefund(userId, est, requestId, `${requestId}:refund`);
    } catch (e) {
      // S0-3：失败落库（幂等），由 billing-reconcile 循环重试，不静默丢账
      console.error(`[billing] refund 失败 requestId=${requestId}`, e);
      await recordBillingFailure({ userId, requestId, kind: "refund", amount: 0n, error: e });
    }
  },
};

// 当前计费实现（真实积分）
export const billing: BillingHooks = creditBilling;
