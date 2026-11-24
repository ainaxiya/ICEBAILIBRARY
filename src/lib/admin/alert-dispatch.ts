import { db } from "@/lib/db";
import { getEmailConfig, sendTemplateMail } from "@/lib/mailer";
import { alertMatchesSubscription, alertTypeLabel, normalizeAdminEmail } from "@/lib/admin/alert-subscription";

// ─── b16 告警按管理员分发 ───
// 只做新增结构：AdminAccount.email + alertSubscriptions；邮件复用 P7 邮件体系。
// 分发失败只记日志，绝不影响巡检 / 对账主流程（否则告警本身会把业务拖垮）。

export interface AlertForDispatch {
  alertType: string;
  level: string;
  message: string;
  createdAt?: Date;
}

export interface AlertDispatchResult {
  sent: number;
  skipped: number;
  failed: number;
}

export async function dispatchAlertToAdmins(alert: AlertForDispatch): Promise<AlertDispatchResult> {
  // 邮件服务未配置/未开启时直接跳过，避免每条告警都抛一次 SMTP 错误刷日志
  const emailCfg = await getEmailConfig();
  if (!emailCfg.enabled) return { sent: 0, skipped: 0, failed: 0 };

  const admins = await db.adminAccount.findMany({
    where: { status: "active" },
    select: { id: true, username: true, nickname: true, email: true, alertSubscriptions: true },
  });

  const time = (alert.createdAt ?? new Date()).toLocaleString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
  const vars = {
    alertType: alert.alertType,
    alertTypeText: alertTypeLabel(alert.alertType),
    level: alert.level === "critical" ? "严重" : "预警",
    message: alert.message.slice(0, 1000),
    time,
  };

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  await Promise.all(
    admins.map(async (a) => {
      const email = normalizeAdminEmail(a.email);
      if (!email || !alertMatchesSubscription(a.alertSubscriptions, alert.alertType)) {
        skipped += 1;
        return;
      }
      try {
        await sendTemplateMail("admin_alert", email, { ...vars, adminName: a.nickname || a.username });
        sent += 1;
      } catch (e) {
        failed += 1;
        console.error(`[alerts] 告警邮件发送失败 admin=${a.username} type=${alert.alertType}`, e);
      }
    })
  );

  return { sent, skipped, failed };
}

/** 后台巡检结束后调用：按水位线把「上次分发之后新增」的告警统一发给订阅管理员。
 *  - 覆盖巡检告警 + 对账扫描写入的账务告警（它们都只写库，不直接发信）；
 *  - 首次启用只对齐水位线，不补发历史告警，避免上线即邮件轰炸；
 *  - 单次最多 100 条，剩余留给下一轮巡检。 */
const WATERMARK_KEY = "alerts_notified_id";
let dispatching = false;

export async function dispatchPendingAlerts(): Promise<{ dispatched: number; sent: number; failed: number }> {
  if (dispatching) return { dispatched: 0, sent: 0, failed: 0 };
  dispatching = true;
  try {
    const [wm, latest] = await Promise.all([
      db.siteSetting.findUnique({ where: { key: WATERMARK_KEY } }),
      db.operationalAlert.findFirst({ orderBy: { id: "desc" }, select: { id: true } }),
    ]);
    const maxId = latest?.id ?? 0;
    if (!wm) {
      await db.siteSetting.create({ data: { key: WATERMARK_KEY, value: String(maxId) } }).catch(() => {});
      return { dispatched: 0, sent: 0, failed: 0 };
    }
    const lastId = Number(wm.value) || 0;
    if (maxId <= lastId) return { dispatched: 0, sent: 0, failed: 0 };

    const pending = await db.operationalAlert.findMany({
      where: { id: { gt: lastId } },
      orderBy: { id: "asc" },
      take: 100,
      select: { id: true, alertType: true, level: true, message: true, createdAt: true },
    });
    if (pending.length === 0) return { dispatched: 0, sent: 0, failed: 0 };

    let sent = 0;
    let failed = 0;
    for (const a of pending) {
      const r = await dispatchAlertToAdmins(a);
      sent += r.sent;
      failed += r.failed;
    }
    const newLast = pending[pending.length - 1].id;
    // 乐观并发：只有水位线没被别人推进时才更新，避免两个进程重复发信
    await db.siteSetting.updateMany({
      where: { key: WATERMARK_KEY, value: wm.value },
      data: { value: String(newLast) },
    });
    return { dispatched: pending.length, sent, failed };
  } finally {
    dispatching = false;
  }
}
