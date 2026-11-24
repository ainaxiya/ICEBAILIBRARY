import { db } from "@/lib/db";

// ─── 运营告警阈值配置（独立模块）───
// 抽出来的原因：billing-reconcile 会被 instrumentation 静态/动态引入并参与 edge 运行时编译，
// 它只需要读配置，不能带上 mailer / nodemailer 这类 Node-only 依赖（会把 edge 编译拖垮）。

export interface AlertsConfig {
  // 自动巡检总开关：关闭后停止一切自动告警生成（cron + 进程内对账扫描）；
  // 后台手动「立即检查」不受影响。
  enabled: boolean;
  // 全站有效 CreditGrant 剩余积分总和低于该值 → 积分池告警；0 = 不限
  creditPoolThreshold: number;
  // 近 7 天毛利率（0-1）低于该值 → 毛利告警；0 = 不启用
  marginRateThreshold: number;
  // 近 24h 支付失败订单数达到该值 → 支付异常告警；0 = 不限
  payFail24hCount: number;
  // 同 IP 近 24h 注册账号数达到该值 → 注册异常告警（批量注册/刷号）；0 = 不限
  registerBurstPerIp: number;
}

export const DEFAULT_ALERTS_CONFIG: AlertsConfig = {
  enabled: true,
  creditPoolThreshold: 100_000,
  marginRateThreshold: 0.1,
  payFail24hCount: 5,
  registerBurstPerIp: 5,
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
      enabled: typeof p.enabled === "boolean" ? p.enabled : DEFAULT_ALERTS_CONFIG.enabled,
      creditPoolThreshold: toNum(p.creditPoolThreshold, DEFAULT_ALERTS_CONFIG.creditPoolThreshold, 0),
      marginRateThreshold: toNum(p.marginRateThreshold, DEFAULT_ALERTS_CONFIG.marginRateThreshold, 0),
      payFail24hCount: toNum(p.payFail24hCount, DEFAULT_ALERTS_CONFIG.payFail24hCount, 0),
      // 允许 0：0 = 不限（老配置里的 0 不再被当成阈值）
      registerBurstPerIp: toNum(p.registerBurstPerIp, DEFAULT_ALERTS_CONFIG.registerBurstPerIp, 0),
    };
  } catch {
    return DEFAULT_ALERTS_CONFIG;
  }
}

export async function saveAlertsConfig(cfg: Partial<AlertsConfig>): Promise<AlertsConfig> {
  const merged: AlertsConfig = {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : DEFAULT_ALERTS_CONFIG.enabled,
    creditPoolThreshold: toNum(cfg.creditPoolThreshold, DEFAULT_ALERTS_CONFIG.creditPoolThreshold, 0),
    marginRateThreshold: toNum(cfg.marginRateThreshold, DEFAULT_ALERTS_CONFIG.marginRateThreshold, 0),
    payFail24hCount: toNum(cfg.payFail24hCount, DEFAULT_ALERTS_CONFIG.payFail24hCount, 0),
    registerBurstPerIp: toNum(cfg.registerBurstPerIp, DEFAULT_ALERTS_CONFIG.registerBurstPerIp, 0),
  };
  await db.siteSetting.upsert({
    where: { key: "alerts_config" },
    update: { value: JSON.stringify(merged) },
    create: { key: "alerts_config", value: JSON.stringify(merged) },
  });
  return merged;
}
