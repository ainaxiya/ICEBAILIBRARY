import { db } from "@/lib/db";
import { dispatchPendingAlerts } from "@/lib/admin/alert-dispatch";
import { getAlertsConfig } from "@/lib/alerts-config";

export type { AlertsConfig } from "@/lib/alerts-config";
export { DEFAULT_ALERTS_CONFIG, getAlertsConfig, saveAlertsConfig } from "@/lib/alerts-config";

// ─── P6 运营告警：积分池 / 毛利 / 支付异常 / 注册异常巡检 ───
// 阈值配置存 SiteSetting key="alerts_config"；命中写 operational_alert 表。
// 统一口径：所有数值阈值「0 = 不限 / 不启用」，不会再出现「填 0 导致人人告警」。
// 已停用类型：user_burst（单会员异常消耗）、reconcile_stuck（预扣卡账）不再生成。

export type AlertType = "credit_pool" | "gross_margin" | "pay_fail" | "register_burst";
export type AlertLevel = "warn" | "critical";

// 同类型告警去重窗口（窗口内已有同类告警则不重复写入，防止手动频繁检查刷屏）
const DUPLICATE_WINDOW_MS = 12 * 3600 * 1000;

async function createAlert(
  alertType: AlertType,
  level: AlertLevel,
  message: string,
  payload: Record<string, unknown>
): Promise<{ id: number; alertType: string; level: string; message: string; createdAt: Date } | null> {
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
  const recent = await db.operationalAlert.findMany({
    where: { alertType, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { payload: true },
  });
  const dedupeKey = typeof payload.userId === "number" ? String(payload.userId) : null;
  const dup = recent.some((r) => {
    if (!dedupeKey) return true; // 同类型窗口内已有告警即去重
    try {
      return String((JSON.parse(r.payload) as { userId?: unknown }).userId ?? "") === dedupeKey;
    } catch {
      return false;
    }
  });
  if (dup) return null;
  const row = await db.operationalAlert.create({
    data: { alertType, level, message, payload: JSON.stringify(payload) },
  });
  return { id: row.id, alertType: row.alertType, level: row.level, message: row.message, createdAt: row.createdAt };
}

export interface AlertCheckResult {
  created: { id: number; alertType: string; level: string; message: string; createdAt: Date }[];
  metrics: {
    poolRemaining: number;
    creditPoolThreshold: number;
    revenueMilli7d: number;
    costMilli7d: number;
    profitMilli7d: number;
    marginRate7d: number | null;
    marginRateThreshold: number;
    payFail24h: number;
    registerBurstIps: number;
  };
}

// ─── 巡检入口：① 积分池 ② 近 7 天毛利 ③ 支付异常 ④ 注册异常 ───
// opts.manual=true：后台「立即检查」手动触发，不受自动巡检总开关限制。
export async function checkOperationalAlerts(opts?: { manual?: boolean }): Promise<AlertCheckResult> {
  const cfg = await getAlertsConfig();
  const created: AlertCheckResult["created"] = [];

  // 总开关：关闭后停止一切自动告警生成。cron 入口已先判断一次，这里兜底，
  // 防止将来新增调用点绕过开关（历史上进程内扫描就是漏网路径）。
  if (!cfg.enabled && !opts?.manual) {
    return {
      created,
      metrics: {
        poolRemaining: 0,
        creditPoolThreshold: cfg.creditPoolThreshold,
        revenueMilli7d: 0,
        costMilli7d: 0,
        profitMilli7d: 0,
        marginRate7d: null,
        marginRateThreshold: cfg.marginRateThreshold,
        payFail24h: 0,
        registerBurstIps: 0,
      },
    };
  }

  // ① 全站有效 CreditGrant 剩余积分池（阈值 0 = 不限）
  const poolAgg = await db.creditGrant.aggregate({
    where: {
      remainingCredits: { gt: 0 },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    _sum: { remainingCredits: true },
  });
  const poolRemaining = Number(poolAgg._sum.remainingCredits ?? 0n);
  if (cfg.creditPoolThreshold > 0 && poolRemaining < cfg.creditPoolThreshold) {
    const a = await createAlert(
      "credit_pool",
      poolRemaining <= 0 ? "critical" : "warn",
      `积分池告警：全站有效积分池剩余 ${poolRemaining.toLocaleString("zh-CN")} 分，低于阈值 ${cfg.creditPoolThreshold.toLocaleString("zh-CN")} 分。影响：新用户发放、兑换与补偿可能余额不足。处理：核对发放计划与消耗速度，必要时补库存；确认仅标记已阅，不会自动补积分。`,
      { poolRemaining, threshold: cfg.creditPoolThreshold }
    );
    if (a) created.push(a);
  }

  // ② 近 7 天毛利：Σpaid_credits×1000 − Σcost_milli（阈值 0 = 不启用）
  const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const marginRows = await db.$queryRaw<
    { paid: bigint; cost: bigint }[]
  >`SELECT COALESCE(SUM("paidCredits"), 0)::bigint AS paid, COALESCE(SUM("costMilli"), 0)::bigint AS cost FROM usage_record WHERE "createdAt" >= ${since7d}`;
  const paidCredits7d = Number(marginRows[0]?.paid ?? 0n);
  const costMilli7d = Number(marginRows[0]?.cost ?? 0n);
  const revenueMilli7d = paidCredits7d * 1000;
  const profitMilli7d = revenueMilli7d - costMilli7d;
  const marginRate7d = revenueMilli7d > 0 ? profitMilli7d / revenueMilli7d : null;
  if (cfg.marginRateThreshold > 0 && marginRate7d !== null) {
    if (profitMilli7d < 0) {
      const a = await createAlert(
        "gross_margin",
        "critical",
        `毛利告警：近 7 天收入 ${(revenueMilli7d / 1000).toFixed(2)} 分、成本 ${(costMilli7d / 1000).toFixed(2)} 分，毛利为负。影响：持续亏损会侵蚀积分池。处理：核查模型定价与上游成本，调整售价或停用负毛利模型；确认仅标记已阅，不会自动改价。`,
        { revenueMilli: revenueMilli7d, costMilli: costMilli7d, profitMilli: profitMilli7d, marginRate: marginRate7d, threshold: cfg.marginRateThreshold }
      );
      if (a) created.push(a);
    } else if (marginRate7d < cfg.marginRateThreshold) {
      const a = await createAlert(
        "gross_margin",
        "warn",
        `毛利告警：近 7 天毛利率 ${(marginRate7d * 100).toFixed(1)}%，低于阈值 ${(cfg.marginRateThreshold * 100).toFixed(1)}%（收入 ${(revenueMilli7d / 1000).toFixed(2)} 分 / 成本 ${(costMilli7d / 1000).toFixed(2)} 分）。影响：利润空间不足。处理：复核定价与成本结构；确认仅标记已阅。`,
        { revenueMilli: revenueMilli7d, costMilli: costMilli7d, profitMilli: profitMilli7d, marginRate: marginRate7d, threshold: cfg.marginRateThreshold }
      );
      if (a) created.push(a);
    }
  }

  // ③ 近 24h 支付失败订单（通道故障 / 恶意下单；排除 qatest_ 测试账号的订单；阈值 0 = 不限）
  const since24h = new Date(Date.now() - 24 * 3600 * 1000);
  const payFailRows = await db.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*)::bigint AS c
      FROM pay_order o
      LEFT JOIN "User" u ON u.id = o."userId"
     WHERE o.status = 'failed'
       AND o."createdAt" >= ${since24h}
       AND (u."username" IS NULL OR u."username" NOT LIKE 'qatest%')`;
  const payFail24h = Number(payFailRows[0]?.c ?? 0n);
  if (cfg.payFail24hCount > 0 && payFail24h >= cfg.payFail24hCount) {
    const a = await createAlert(
      "pay_fail",
      payFail24h >= cfg.payFail24hCount * 3 ? "critical" : "warn",
      `支付异常：近 24 小时支付失败订单 ${payFail24h} 笔，达到阈值 ${cfg.payFail24hCount} 笔。影响：用户充值受阻，可能是通道故障或恶意下单。处理：核查支付通道回调与失败原因，必要时切换通道；确认仅标记已阅，不会自动补单。`,
      { payFail24h, threshold: cfg.payFail24hCount }
    );
    if (a) created.push(a);
  }

  // ④ 同 IP 近 24h 注册异常（批量注册/刷号；排除 qatest_；阈值 0 = 不限 → 不查询不判定）
  let regBursts: { ip: string; cnt: bigint }[] = [];
  if (cfg.registerBurstPerIp > 0) {
    regBursts = await db.$queryRaw<
      { ip: string; cnt: bigint }[]
    >`SELECT "registerIp" AS ip, COUNT(*)::bigint AS cnt
        FROM "User"
       WHERE "createdAt" >= ${since24h}
         AND "registerIp" IS NOT NULL
         AND "username" NOT LIKE 'qatest%'
       GROUP BY "registerIp"
      HAVING COUNT(*) >= ${cfg.registerBurstPerIp}
       ORDER BY 2 DESC LIMIT 20`;
  }
  for (const r of regBursts) {
    const ip = String(r.ip);
    const cnt = Number(r.cnt);
    const a = await createAlert(
      "register_burst",
      cnt >= cfg.registerBurstPerIp * 3 ? "critical" : "warn",
      `注册异常：IP ${ip} 近 24 小时注册 ${cnt} 个账号，达到阈值 ${cfg.registerBurstPerIp} 个。影响：疑似批量注册/刷号，可能套取新用户赠送。处理：核对该 IP 注册账号并限制注册；确认仅标记已阅，不会自动封号。`,
      { ip, cnt, threshold: cfg.registerBurstPerIp }
    );
    if (a) created.push(a);
  }

  // b16：巡检结束后按水位线统一分发新增告警（含对账扫描写入的账务告警），
  // 邮件发送失败不影响巡检结果，只记日志。
  try {
    await dispatchPendingAlerts();
  } catch (e) {
    console.error("[alerts] 告警分发异常", e);
  }

  return {
    created,
    metrics: {
      poolRemaining,
      creditPoolThreshold: cfg.creditPoolThreshold,
      revenueMilli7d,
      costMilli7d,
      profitMilli7d,
      marginRate7d,
      marginRateThreshold: cfg.marginRateThreshold,
      payFail24h,
      registerBurstIps: regBursts.length,
    },
  };
}
