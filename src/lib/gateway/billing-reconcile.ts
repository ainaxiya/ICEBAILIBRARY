import { db } from "@/lib/db";
import { creditBilling } from "./billing";

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

// 进程内周期重试（由 instrumentation 启动；单实例 pm2 部署天然单飞）
const LOOP_INTERVAL_MS = 60_000;

export function startBillingReconcileLoop() {
  const g = globalThis as { __billingReconcileLoop?: boolean };
  if (g.__billingReconcileLoop) return;
  g.__billingReconcileLoop = true;
  const timer = setInterval(() => {
    retryPendingBilling().catch((e) => {
      console.error("[billing-reconcile] 循环异常", e);
    });
  }, LOOP_INTERVAL_MS);
  // 不阻止进程退出
  if (typeof timer.unref === "function") timer.unref();
}
