import { db } from "@/lib/db";
import { creditBilling } from "./billing";
import { alertTime, featureLabel, isTestAccount, memberLabel, signedCredits } from "@/lib/alert-format";
import { getAlertsConfig } from "@/lib/alerts-config";

// ─── S0-3 计费对账：settle/refund 失败落库 + 幂等重试 ───
// 落库：requestId+kind 唯一，重复失败只更新 lastError，不产生重复对账单。
// 重试安全性：creditBilling.settle/refund 内部按 requestId 幂等（CreditLedger.requestId
// 唯一约束），重放同一请求不会重复扣款/退款。
// 告警：重试失败打 [billing-reconcile] 错误日志（pm2 logs 可监控）；连续失败 ≥10 次标记 failed。

const MAX_ATTEMPTS = 10;

export async function recordBillingFailure(params: {
  userId: number;
  requestId: string;
  kind: "settle" | "refund";
  amount: bigint;
  error: unknown;
}) {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  try {
    await db.billingReconcile.upsert({
      where: {
        requestId_kind: { requestId: params.requestId, kind: params.kind },
      },
      create: {
        userId: params.userId,
        requestId: params.requestId,
        kind: params.kind,
        amount: params.amount,
        status: "pending",
        lastError: message.slice(0, 1000),
      },
      update: {
        status: "pending",
        lastError: message.slice(0, 1000),
      },
    });
  } catch (e) {
    // 对账单写失败也要可见（比如主库不可用），不能静默吞掉
    console.error(
      `[billing-reconcile] 落库失败 requestId=${params.requestId} kind=${params.kind}`,
      e
    );
  }
}

// 扫描 pending 对账单并重试（幂等，可安全并发触发）
export async function retryPendingBilling(limit = 50): Promise<{ scanned: number; done: number }> {
  const rows = await db.billingReconcile.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let done = 0;
  for (const row of rows) {
    // 会员已注销（userId 置空）：无账户可结算/退款，直接标记失败并留档
    if (row.userId === null) {
      await db.billingReconcile.update({
        where: { id: row.id },
        data: { status: "failed", attempts: { increment: 1 }, lastError: "会员已注销，无法结算" },
      });
      continue;
    }
    try {
      if (row.kind === "settle") {
        await creditBilling.settle(row.userId, row.requestId, Number(row.amount));
      } else {
        await creditBilling.refund(row.userId, row.requestId);
      }
      await db.billingReconcile.update({
        where: { id: row.id },
        data: { status: "done", attempts: { increment: 1 }, lastError: null },
      });
      done++;
    } catch (e) {
      const attempts = row.attempts + 1;
      await db.billingReconcile.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: (e instanceof Error ? e.message : String(e)).slice(0, 1000),
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        },
      });
      // 告警：每次失败都可见；failed 表示需要人工介入
      console.error(
        `[billing-reconcile] 重试失败 requestId=${row.requestId} kind=${row.kind} attempts=${attempts}${attempts >= MAX_ATTEMPTS ? "（已达上限，需人工处理）" : ""}`,
        e
      );
    }
  }
  if (rows.length > 0) {
    console.log(`[billing-reconcile] 本轮扫描 ${rows.length} 条，成功恢复 ${done} 条`);
  }
  return { scanned: rows.length, done };
}

// ─── P3 对账扫描（方案 9.4）：异常账务巡检 → OperationalAlert ───
// 只保留两类「不会自动收口」的问题：
//   ① 负数/异常用量（数据异常，必须人工核对）
//   ② 幂等重试耗尽的对账单（自动重试已放弃，必须人工补账/退款）
// 预扣卡账（reconcile_stuck）已整类取消：会员提交模型后系统会轮询结果接口直到有结果，
// 卡账由轮询链路自行收口，不再用告警兜底，避免拿告警当兜底制造误报。

const SCAN_WINDOW_MS = 7 * 24 * 3600_000; // 只扫最近 7 天：更早的历史问题交给「运营告警」页人工处理
const SCAN_EVERY_ROUNDS = 5; // 每 5 轮（约 5 分钟）扫描一次
const ALERT_DEDUP_MS = 12 * 3600_000; // 同一问题 12 小时内不重复告警

async function writeScanAlert(
  alertType: "usage_invalid" | "reconcile_failed",
  level: "warn" | "critical",
  message: string,
  payload: Record<string, unknown>
) {
  console.error(`[reconcile-scan] ${message}`);
  try {
    await db.operationalAlert.create({
      data: { alertType, level, message: message.slice(0, 500), payload: JSON.stringify(payload) },
    });
  } catch (e) {
    console.error("[reconcile-scan] 告警写入失败", e);
  }
}

export async function scanReconcile(): Promise<{ negative: number; failed: number }> {
  let negative = 0;
  let failed = 0;
  const windowStart = new Date(Date.now() - SCAN_WINDOW_MS);

  // 已存在同用量/同对账单的告警（含已确认）在去重窗口内不再写入：
  // 既避免进程重启后内存去重失效，也满足「已确认的告警不在同一窗口内重复弹」。
  const recentAlerts = await db.operationalAlert.findMany({
    where: {
      alertType: { in: ["usage_invalid", "reconcile_failed"] },
      createdAt: { gte: new Date(Date.now() - ALERT_DEDUP_MS) },
    },
    select: { alertType: true, payload: true },
  });
  const alertedUsageIds = new Set<number>();
  const alertedReconcile = new Set<string>();
  for (const a of recentAlerts) {
    try {
      const p = JSON.parse(a.payload) as { usageId?: number; requestId?: string; kind?: string };
      if (a.alertType === "usage_invalid" && typeof p.usageId === "number") alertedUsageIds.add(p.usageId);
      if (a.alertType === "reconcile_failed" && p.requestId) {
        alertedReconcile.add(`${p.requestId}:${p.kind ?? "settle"}`);
      }
    } catch {
      // 历史 payload 异常时忽略，不影响扫描
    }
  }

  // 1. 异常用量：负数计费字段（只扫最近 7 天）
  const badUsage = await db.usageRecord.findMany({
    where: { AND: [{ createdAt: { gte: windowStart } }, { OR: [{ paidCredits: { lt: 0n } }, { outputTokens: { lt: 0 } }, { promptTokens: { lt: 0 } }] }] },
    orderBy: { id: "desc" },
    take: 20,
  });
  for (const u of badUsage) {
    if (alertedUsageIds.has(u.id)) continue;
    const user = u.userId
      ? await db.user.findUnique({ where: { id: u.userId }, select: { username: true, nickname: true } })
      : null;
    if (isTestAccount(user?.username)) continue;
    negative++;
    await writeScanAlert(
      "usage_invalid",
      "critical",
      `用量记录异常（负数用量）：${memberLabel(user?.username, user?.nickname)} 于 ${alertTime(u.createdAt)} 调用 ${u.modelSnapshot}·${featureLabel(u.endpointType)}，记录出现负数计费字段（实扣 ${signedCredits(u.paidCredits)} / 输入 ${u.promptTokens} tok / 输出 ${u.outputTokens} tok）。影响：会员扣费与毛利统计可能失真。处理：核对上游用量后人工修正；确认仅标记已阅，不会自动改流水。`,
      {
        usageId: u.id,
        requestId: u.requestId,
        userId: u.userId,
        username: user?.username ?? null,
        nickname: user?.nickname ?? null,
        model: u.modelSnapshot,
        endpointType: u.endpointType,
        feature: featureLabel(u.endpointType),
        paidCredits: u.paidCredits.toString(),
        usageCreatedAt: u.createdAt.toISOString(),
      }
    );
  }

  // 2. 幂等重试耗尽的对账单（需人工处理，只扫最近 7 天）
  const failedRows = await db.billingReconcile.findMany({
    where: { status: "failed", updatedAt: { gte: windowStart } },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  for (const fr of failedRows) {
    if (alertedReconcile.has(`${fr.requestId}:${fr.kind}`)) continue;
    const [user, usage] = await Promise.all([
      fr.userId ? db.user.findUnique({ where: { id: fr.userId }, select: { username: true, nickname: true } }) : null,
      db.usageRecord.findFirst({
        where: { requestId: fr.requestId },
        select: { modelSnapshot: true, endpointType: true },
      }),
    ]);
    if (isTestAccount(user?.username)) continue;
    const kindLabel = fr.kind === "refund" ? "退款" : "结算";
    failed++;
    await writeScanAlert(
      "reconcile_failed",
      "critical",
      `对账重试耗尽：${memberLabel(user?.username, user?.nickname)} 于 ${alertTime(fr.updatedAt)} 的 ${usage?.modelSnapshot ?? "未知模型"}·${featureLabel(usage?.endpointType)} ${kindLabel}对账已重试 ${fr.attempts} 次仍失败（${kindLabel}金额 ${Math.abs(Number(fr.amount)).toLocaleString("zh-CN")} 分）：${(fr.lastError || "未知错误").slice(0, 120)}。影响：该笔${kindLabel}未落账，会员余额与实际用量可能不一致。处理：人工核对后补账或退款；确认仅标记已阅，不会自动补账。`,
      {
        requestId: fr.requestId,
        kind: fr.kind,
        userId: fr.userId,
        username: user?.username ?? null,
        nickname: user?.nickname ?? null,
        model: usage?.modelSnapshot ?? null,
        endpointType: usage?.endpointType ?? null,
        feature: featureLabel(usage?.endpointType),
        amount: fr.amount.toString(),
        attempts: fr.attempts,
        lastError: (fr.lastError || "").slice(0, 200),
      }
    );
  }

  return { negative, failed };
}

// 进程内周期重试（由 instrumentation 启动；单实例 pm2 部署天然单飞）
const LOOP_INTERVAL_MS = 60_000;
let scanCounter = 0;

export function startBillingReconcileLoop() {
  const g = globalThis as { __billingReconcileLoop?: boolean };
  if (g.__billingReconcileLoop) return;
  g.__billingReconcileLoop = true;
  const timer = setInterval(async () => {
    retryPendingBilling().catch((e) => {
      console.error("[billing-reconcile] 循环异常", e);
    });
    scanCounter += 1;
    if (scanCounter % SCAN_EVERY_ROUNDS === 0) {
      // 根因修复：进程内扫描此前完全不读「自动巡检」开关，导致后台明明关着开关
      // 仍会写告警。这里在生成任何告警前先读开关，关闭则整轮跳过（对账单重试不受影响）。
      try {
        const cfg = await getAlertsConfig();
        if (!cfg.enabled) return;
      } catch (e) {
        console.error("[reconcile-scan] 读取告警开关失败，本轮跳过", e);
        return;
      }
      scanReconcile().catch((e) => console.error("[reconcile-scan] 扫描异常", e));
    }
  }, LOOP_INTERVAL_MS);
  // 不阻止进程退出
  if (typeof timer.unref === "function") timer.unref();
}
