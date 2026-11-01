import { db } from "@/lib/db";

// ─── P6 运营告警：余额 / 毛利 / 单用户异常消耗巡检 ───
// 阈值配置存 SiteSetting key="alerts_config"；命中写 operational_alert 表。
// TODO: 本地开发无 cron，checkOperationalAlerts 由后台「运营告警」页手动触发；
//       上线后接定时任务（建议每小时）自动巡检。

export type AlertType = "credit_pool" | "gross_margin" | "user_burst";
export type AlertLevel = "warn" | "critical";

// 告警阈值配置（SiteSetting key="alerts_config"）
export interface AlertsConfig {
  // 全站有效 CreditGrant 剩余积分总和低于该值 → 积分池告警
  creditPoolThreshold: number;
  // 近 7 天毛利率（0-1）低于该值 → 毛利告警
  marginRateThreshold: number;
  // 单用户近 24h 消耗积分超过该值 → 异常消耗告警
  userBurst24hCredits: number;
}

export const DEFAULT_ALERTS_CONFIG: AlertsConfig = {
  creditPoolThreshold: 100_000,
  marginRateThreshold: 0.1,
  userBurst24hCredits: 5_000,
};

function toNum(v: unknown, def: number, min: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : def;
}

export async function getAlertsConfig(): Promise<AlertsConfig> {
  const row = await db.siteSetting.findUnique({ where: { key: "alerts_config" } });
  if (!row) return DEFAULT_ALERTS_CONFIG;
  try {
    const p = JSON.parse(row.value) as Partial<AlertsConfig>;
    return {
      creditPoolThreshold: toNum(p.creditPoolThreshold, DEFAULT_ALERTS_CONFIG.creditPoolThreshold, 0),
      marginRateThreshold: toNum(p.marginRateThreshold, DEFAULT_ALERTS_CONFIG.marginRateThreshold, 0),
      userBurst24hCredits: toNum(p.userBurst24hCredits, DEFAULT_ALERTS_CONFIG.userBurst24hCredits, 0),
    };
  } catch {
    return DEFAULT_ALERTS_CONFIG;
  }
}

export async function saveAlertsConfig(cfg: Partial<AlertsConfig>): Promise<AlertsConfig> {
  const merged: AlertsConfig = {
    creditPoolThreshold: toNum(cfg.creditPoolThreshold, DEFAULT_ALERTS_CONFIG.creditPoolThreshold, 0),
    marginRateThreshold: toNum(cfg.marginRateThreshold, DEFAULT_ALERTS_CONFIG.marginRateThreshold, 0),
    userBurst24hCredits: toNum(cfg.userBurst24hCredits, DEFAULT_ALERTS_CONFIG.userBurst24hCredits, 0),
  };
  await db.siteSetting.upsert({
    where: { key: "alerts_config" },
    update: { value: JSON.stringify(merged) },
    create: { key: "alerts_config", value: JSON.stringify(merged) },
  });
  return merged;
}

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
    burstUsers: number;
    userBurst24hCredits: number;
  };
}

// ─── 巡检入口：① 积分池 ② 近 7 天毛利 ③ 单用户 24h 异常消耗 ───
export async function checkOperationalAlerts(): Promise<AlertCheckResult> {
  const cfg = await getAlertsConfig();
  const created: AlertCheckResult["created"] = [];

  // ① 全站有效 CreditGrant 剩余积分池
  const poolAgg = await db.creditGrant.aggregate({
    where: {
      remainingCredits: { gt: 0 },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    _sum: { remainingCredits: true },
  });
  const poolRemaining = Number(poolAgg._sum.remainingCredits ?? 0n);
  if (poolRemaining < cfg.creditPoolThreshold) {
    const a = await createAlert(
      "credit_pool",
      poolRemaining <= 0 ? "critical" : "warn",
      `全站有效积分池剩余 ${poolRemaining} 积分，低于阈值 ${cfg.creditPoolThreshold} 积分，请关注发放/消耗节奏`,
      { poolRemaining, threshold: cfg.creditPoolThreshold }
    );
    if (a) created.push(a);
  }

  // ② 近 7 天毛利：Σpaid_credits×1000 − Σcost_milli
  const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const marginRows = await db.$queryRaw<
    { paid: bigint; cost: bigint }[]
  >`SELECT COALESCE(SUM("paidCredits"), 0)::bigint AS paid, COALESCE(SUM("costMilli"), 0)::bigint AS cost FROM usage_record WHERE "createdAt" >= ${since7d}`;
  const paidCredits7d = Number(marginRows[0]?.paid ?? 0n);
  const costMilli7d = Number(marginRows[0]?.cost ?? 0n);
  const revenueMilli7d = paidCredits7d * 1000;
  const profitMilli7d = revenueMilli7d - costMilli7d;
  const marginRate7d = revenueMilli7d > 0 ? profitMilli7d / revenueMilli7d : null;
  if (marginRate7d !== null) {
    if (profitMilli7d < 0) {
      const a = await createAlert(
        "gross_margin",
        "critical",
        `近 7 天毛利为负（收入 ${revenueMilli7d} 毫积分 / 成本 ${costMilli7d} 毫积分），请立即核查定价与成本`,
        { revenueMilli: revenueMilli7d, costMilli: costMilli7d, profitMilli: profitMilli7d, marginRate: marginRate7d, threshold: cfg.marginRateThreshold }
      );
      if (a) created.push(a);
    } else if (marginRate7d < cfg.marginRateThreshold) {
      const a = await createAlert(
        "gross_margin",
        "warn",
        `近 7 天毛利率 ${(marginRate7d * 100).toFixed(1)}%，低于阈值 ${(cfg.marginRateThreshold * 100).toFixed(1)}%`,
        { revenueMilli: revenueMilli7d, costMilli: costMilli7d, profitMilli: profitMilli7d, marginRate: marginRate7d, threshold: cfg.marginRateThreshold }
      );
      if (a) created.push(a);
    }
  }

  // ③ 单用户近 24h 异常消耗
  const since24h = new Date(Date.now() - 24 * 3600 * 1000);
  const bursts = await db.$queryRaw<
    { userId: number; spent: bigint }[]
  >`SELECT "userId", COALESCE(SUM("paidCredits"), 0)::bigint AS spent FROM usage_record WHERE "createdAt" >= ${since24h} GROUP BY "userId" HAVING SUM("paidCredits") > ${cfg.userBurst24hCredits} ORDER BY 2 DESC LIMIT 20`;
  for (const b of bursts) {
    const userId = Number(b.userId);
    const spent = Number(b.spent);
    const a = await createAlert(
      "user_burst",
      spent >= cfg.userBurst24hCredits * 3 ? "critical" : "warn",
      `用户 #${userId} 近 24 小时消耗 ${spent} 积分，超过阈值 ${cfg.userBurst24hCredits} 积分，请核查是否盗刷`,
      { userId, spent, threshold: cfg.userBurst24hCredits }
    );
    if (a) created.push(a);
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
      burstUsers: bursts.length,
      userBurst24hCredits: cfg.userBurst24hCredits,
    },
  };
}
