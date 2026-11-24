// ─── 后台仪表盘指标聚合（页面 SSR 与 /api/admin/dashboard/metrics 共用）───
// 口径：
//   · 经营窗口按 Asia/Shanghai 自然日切分（UTC+8，无夏令时）
//   · 余额真源 = credit_grant 有效剩余；消耗 = usage_record.paidCredits；内部成本 = costMilli（毫积分）
//   · 纯只读聚合，不改库结构；单个子查询失败回落 0/空数组并保留 console.error
import { db } from "@/lib/db";
import { estimateSupportDays } from "@/lib/ops-metrics";
import { getQueueStatusSnapshot } from "@/lib/ops/queue-status";

type BusinessWindow = {
  revenueCents: number;
  creditsIssued: number;
  creditsSpent: number;
  costMilli: number;
  profitMilli: number;
  marginRate: number | null;
};

export type DashboardMetrics = {
  generatedAt: string; // ISO
  business: {
    today: BusinessWindow;
    d7: BusinessWindow;
    d30: BusinessWindow;
  };
  pool: {
    totalBalance: number;
    supportDays: number | null;
    buckets: { zero: number; low: number; mid: number; high: number; vip: number };
    expiring7d: number;
    expiring30d: number;
    netFlow7d: { grant: number; consume: number; refund: number; adjust: number; net: number };
  };
  queue: {
    workerOnline: boolean;
    redisOk: boolean;
    lastSeenAt: string | null;
    inflight: number;
    channels: { key: string; label: string; online: boolean; inflight: number; concurrency: number }[];
    media24h: { total: number; succeeded: number; failed: number; running: number; queued: number; successRate: number | null };
    stuckMedia: number;
    video24h: { total: number; succeeded: number; failed: number; running: number; queued: number };
    reconcile: { pending: number; failed: number };
  };
  alerts: {
    unacked: number;
    recent: { id: number; alertType: string; level: string; message: string; createdAt: string }[];
    lastCheckedAt: string | null;
  };
  anomalies: {
    topSpenders: { userId: number; name: string; credits: number; calls: number }[];
    zeroBalanceActive: number;
    reconcileUsers: number;
    banned: number;
    commentBanned: number;
  };
  growth: {
    daily: { date: string; label: string; registrations: number; activeUsers: number }[];
    newUsers7d: number;
    newUsers7dPaid: number;
  };
  payments: {
    d24: { paidCount: number; paidCents: number; failedCount: number };
    d7: { paidCount: number; paidCents: number; failedCount: number };
    pendingStale: number;
    topPacks: { name: string; orders: number; cents: number }[];
  };
  playground: {
    sessionsToday: number;
    messagesToday: number;
    media24h: { total: number; succeeded: number; failed: number };
    guestKeys: number;
    guestTrials: number;
    guestToday: number;
  };
  todo: { pendingPrompts: number; openTickets: number; unackedAlerts: number };
};

const HOUR_MS = 3600_000;
const DAY_MS = 86400_000;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;

/**
 * 上海自然日零点（UTC+8 无夏令时）。
 * offsetDays = 0 今天零点；-1 昨天零点；-6 = 近 7 个自然日的起点。
 */
export function shanghaiMidnight(offsetDays = 0): Date {
  const wall = new Date(Date.now() + SHANGHAI_OFFSET_MS);
  const midnightUtc = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  return new Date(midnightUtc - SHANGHAI_OFFSET_MS + offsetDays * DAY_MS);
}

// 毫秒时间戳 → 上海时区的 YYYY-MM-DD
function shanghaiDateKey(ms: number): string {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[dashboard-metrics] ${label} 聚合失败：`, e);
    return fallback;
  }
}

const EMPTY_WINDOW: BusinessWindow = {
  revenueCents: 0,
  creditsIssued: 0,
  creditsSpent: 0,
  costMilli: 0,
  profitMilli: 0,
  marginRate: null,
};

async function businessWindow(label: string, since: Date): Promise<BusinessWindow> {
  return safe(
    label,
    async () => {
      const [revRows, issuedRows, spentRows] = await Promise.all([
        db.$queryRaw<{ cents: bigint }[]>`
          SELECT COALESCE(SUM("amountCents"), 0)::bigint AS cents
          FROM pay_order
          WHERE status = 'paid' AND COALESCE("paidAt", "createdAt") >= ${since}
        `,
        db.$queryRaw<{ credits: bigint }[]>`
          SELECT COALESCE(SUM("totalCredits"), 0)::bigint AS credits
          FROM credit_grant
          WHERE "createdAt" >= ${since}
        `,
        db.$queryRaw<{ credits: bigint; cost: bigint }[]>`
          SELECT COALESCE(SUM("paidCredits"), 0)::bigint AS credits,
                 COALESCE(SUM("costMilli"), 0)::bigint AS cost
          FROM usage_record
          WHERE "createdAt" >= ${since}
        `,
      ]);
      const revenueCents = n(revRows[0]?.cents);
      const creditsIssued = n(issuedRows[0]?.credits);
      const creditsSpent = n(spentRows[0]?.credits);
      const costMilli = n(spentRows[0]?.cost);
      const profitMilli = creditsSpent * 1000 - costMilli;
      const marginRate = creditsSpent > 0 ? profitMilli / (creditsSpent * 1000) : null;
      return { revenueCents, creditsIssued, creditsSpent, costMilli, profitMilli, marginRate };
    },
    { ...EMPTY_WINDOW }
  );
}

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const now = new Date();
  const today = shanghaiMidnight(0);
  const d7 = shanghaiMidnight(-6); // 近 7 个自然日（含今天）
  const d30 = shanghaiMidnight(-29); // 近 30 个自然日（含今天）
  const d14 = shanghaiMidnight(-13); // 趋势图 14 天
  const since24h = new Date(now.getTime() - DAY_MS);
  const since7d = new Date(now.getTime() - 7 * DAY_MS);
  const since30min = new Date(now.getTime() - 30 * 60_000);

  const [businessToday, business7d, business30d] = await Promise.all([
    businessWindow("business.today", today),
    businessWindow("business.d7", d7),
    businessWindow("business.d30", d30),
  ]);

  // ── 积分池健康 ──
  const pool = await safe(
    "pool",
    async () => {
      const [balRows, spent7dRows, poolRows, flowRows] = await Promise.all([
        db.$queryRaw<{ zero: number; low: number; mid: number; high: number; vip: number }[]>`
          SELECT
            COUNT(*) FILTER (WHERE t.bal = 0)::int AS zero,
            COUNT(*) FILTER (WHERE t.bal > 0 AND t.bal <= 1000)::int AS low,
            COUNT(*) FILTER (WHERE t.bal > 1000 AND t.bal <= 10000)::int AS mid,
            COUNT(*) FILTER (WHERE t.bal > 10000 AND t.bal <= 100000)::int AS high,
            COUNT(*) FILTER (WHERE t.bal > 100000)::int AS vip
          FROM (
            SELECT u.id, COALESCE(SUM(g."remainingCredits"), 0) AS bal
            FROM "User" u
            JOIN "membership_level" ml ON ml."code" = u."membershipLevel"
            LEFT JOIN credit_grant g
              ON g."userId" = u.id
             AND g."remainingCredits" > 0
             AND (g."expiresAt" IS NULL OR g."expiresAt" > now())
            WHERE ml."isSystem" = false
            GROUP BY u.id
          ) t
        `,
        db.$queryRaw<{ credits: bigint }[]>`
          SELECT COALESCE(SUM("paidCredits"), 0)::bigint AS credits
          FROM usage_record
          WHERE "createdAt" >= now() - interval '7 days'
        `,
        db.$queryRaw<{ total: bigint; e7: bigint; e30: bigint }[]>`
          SELECT
            COALESCE(SUM("remainingCredits"), 0)::bigint AS total,
            COALESCE(SUM("remainingCredits") FILTER (
              WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= now() + interval '7 days'
            ), 0)::bigint AS e7,
            COALESCE(SUM("remainingCredits") FILTER (
              WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= now() + interval '30 days'
            ), 0)::bigint AS e30
          FROM credit_grant
          WHERE "remainingCredits" > 0
            AND ("expiresAt" IS NULL OR "expiresAt" > now())
        `,
        db.$queryRaw<{ reason: string | null; amount: bigint }[]>`
          SELECT reason, COALESCE(SUM("changeAmount"), 0)::bigint AS amount
          FROM credit_ledger
          WHERE "createdAt" >= ${d7}
          GROUP BY reason
        `,
      ]);

      const bal = balRows[0] || { zero: 0, low: 0, mid: 0, high: 0, vip: 0 };
      const buckets = {
        zero: n(bal.zero),
        low: n(bal.low),
        mid: n(bal.mid),
        high: n(bal.high),
        vip: n(bal.vip),
      };
      const totalBalance = n(poolRows[0]?.total);
      const spent7d = n(spent7dRows[0]?.credits);
      const flow = { grant: 0, consume: 0, refund: 0, adjust: 0 };
      for (const r of flowRows) {
        const amount = n(r.amount);
        if (r.reason === "grant") flow.grant += amount;
        else if (r.reason === "consume") flow.consume += amount;
        else if (r.reason === "refund") flow.refund += amount;
        else flow.adjust += amount; // admin_adjust / 未知原因统一归 adjust
      }
      // 余额合计直接由分桶求和得到（分桶 SQL 已按会员去重，避免重复计 system 等级）
      return {
        totalBalance,
        supportDays: estimateSupportDays(totalBalance, spent7d),
        buckets,
        expiring7d: n(poolRows[0]?.e7),
        expiring30d: n(poolRows[0]?.e30),
        netFlow7d: {
          ...flow,
          net: flow.grant + flow.consume + flow.refund + flow.adjust,
        },
      };
    },
    {
      totalBalance: 0,
      supportDays: null,
      buckets: { zero: 0, low: 0, mid: 0, high: 0, vip: 0 },
      expiring7d: 0,
      expiring30d: 0,
      netFlow7d: { grant: 0, consume: 0, refund: 0, adjust: 0, net: 0 },
    }
  );

  // ── 任务队列与失败率 ──
  const queue = await safe(
    "queue",
    async () => {
      const [snap, mediaRows, stuckRows, videoRows, recRows] = await Promise.all([
        getQueueStatusSnapshot(),
        db.$queryRaw<
          { total: number; succeeded: number; failed: number; running: number; queued: number }[]
        >`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE status = 'running')::int AS running,
            COUNT(*) FILTER (WHERE status = 'queued')::int AS queued
          FROM playground_media_task
          WHERE "createdAt" >= ${since24h}
        `,
        db.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n
          FROM playground_media_task
          WHERE status IN ('queued', 'running')
            AND "lockedUntil" < now() - interval '5 minutes'
        `,
        db.$queryRaw<
          { total: number; succeeded: number; failed: number; running: number; queued: number }[]
        >`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE status = 'processing')::int AS running,
            COUNT(*) FILTER (WHERE status = 'queued')::int AS queued
          FROM video_task
          WHERE "createdAt" >= ${since24h}
        `,
        db.$queryRaw<{ pending: number; failed: number }[]>`
          SELECT
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
          FROM billing_reconcile
        `,
      ]);

      const media = mediaRows[0] || { total: 0, succeeded: 0, failed: 0, running: 0, queued: 0 };
      const mediaTotal = n(media.total);
      const mediaSucceeded = n(media.succeeded);
      const video = videoRows[0] || { total: 0, succeeded: 0, failed: 0, running: 0, queued: 0 };
      return {
        workerOnline: snap.worker.online,
        redisOk: snap.redisOk,
        lastSeenAt: snap.worker.lastSeenAt != null ? new Date(snap.worker.lastSeenAt).toISOString() : null,
        inflight: n(snap.workerInflight),
        channels: snap.channels.map((c) => ({
          key: c.key,
          label: c.label || c.key,
          online: c.online,
          inflight: n(c.running),
          concurrency: n(c.concurrency),
        })),
        media24h: {
          total: mediaTotal,
          succeeded: mediaSucceeded,
          failed: n(media.failed),
          running: n(media.running),
          queued: n(media.queued),
          successRate: mediaTotal > 0 ? mediaSucceeded / mediaTotal : null,
        },
        stuckMedia: n(stuckRows[0]?.n),
        video24h: {
          total: n(video.total),
          succeeded: n(video.succeeded),
          failed: n(video.failed),
          running: n(video.running),
          queued: n(video.queued),
        },
        reconcile: {
          pending: n(recRows[0]?.pending),
          failed: n(recRows[0]?.failed),
        },
      };
    },
    {
      workerOnline: false,
      redisOk: false,
      lastSeenAt: null,
      inflight: 0,
      channels: [],
      media24h: { total: 0, succeeded: 0, failed: 0, running: 0, queued: 0, successRate: null },
      stuckMedia: 0,
      video24h: { total: 0, succeeded: 0, failed: 0, running: 0, queued: 0 },
      reconcile: { pending: 0, failed: 0 },
    }
  );

  // ── 未确认告警（不触发巡检，只读表）──
  const alerts = await safe(
    "alerts",
    async () => {
      const [unacked, recent, last] = await Promise.all([
        db.operationalAlert.count({ where: { ackAt: null } }),
        db.operationalAlert.findMany({
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, alertType: true, level: true, message: true, createdAt: true },
        }),
        db.operationalAlert.findFirst({
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
      ]);
      return {
        unacked,
        recent: recent.map((a) => ({
          id: a.id,
          alertType: a.alertType,
          level: a.level,
          message: a.message,
          createdAt: a.createdAt.toISOString(),
        })),
        lastCheckedAt: last ? last.createdAt.toISOString() : null,
      };
    },
    { unacked: 0, recent: [], lastCheckedAt: null }
  );

  // ── 异常会员 ──
  const anomalies = await safe(
    "anomalies",
    async () => {
      const [spenderRows, zeroRows, recUserRows, banned, commentBanned] = await Promise.all([
        db.$queryRaw<{ userId: number; name: string | null; credits: bigint; calls: number }[]>`
          SELECT ur."userId" AS "userId",
                 COALESCE(NULLIF(u."nickname", ''), u."username", '会员#' || ur."userId"::text) AS name,
                 COALESCE(SUM(ur."paidCredits"), 0)::bigint AS credits,
                 COUNT(*)::int AS calls
          FROM usage_record ur
          LEFT JOIN "User" u ON u.id = ur."userId"
          WHERE ur."createdAt" >= ${since24h} AND ur."userId" IS NOT NULL
          GROUP BY ur."userId", u."nickname", u."username"
          ORDER BY credits DESC
          LIMIT 10
        `,
        db.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n
          FROM (
            SELECT u.id
            FROM "User" u
            JOIN "membership_level" ml ON ml."code" = u."membershipLevel"
            WHERE ml."isSystem" = false
              AND EXISTS (
                SELECT 1 FROM usage_record r
                WHERE r."userId" = u.id AND r."createdAt" >= ${since24h}
              )
              AND NOT EXISTS (
                SELECT 1 FROM credit_grant g
                WHERE g."userId" = u.id
                  AND g."remainingCredits" > 0
                  AND (g."expiresAt" IS NULL OR g."expiresAt" > now())
              )
          ) t
        `,
        db.$queryRaw<{ n: number }[]>`
          SELECT COUNT(DISTINCT "userId")::int AS n
          FROM billing_reconcile
          WHERE status = 'pending' AND "userId" IS NOT NULL
        `,
        db.user.count({ where: { status: "banned" } }),
        db.user.count({ where: { commentBanned: true } }),
      ]);
      return {
        topSpenders: spenderRows.map((r) => ({
          userId: n(r.userId),
          name: r.name || `会员#${n(r.userId)}`,
          credits: n(r.credits),
          calls: n(r.calls),
        })),
        zeroBalanceActive: n(zeroRows[0]?.n),
        reconcileUsers: n(recUserRows[0]?.n),
        banned: n(banned),
        commentBanned: n(commentBanned),
      };
    },
    { topSpenders: [], zeroBalanceActive: 0, reconcileUsers: 0, banned: 0, commentBanned: 0 }
  );

  // ── 注册与活跃趋势（近 14 个自然日）──
  const growth = await safe(
    "growth",
    async () => {
      const [regRows, activeRows, new7Rows, new7PaidRows] = await Promise.all([
        db.$queryRaw<{ d: string; n: number }[]>`
          SELECT to_char(date_trunc('day', u."createdAt" + interval '8 hours'), 'YYYY-MM-DD') AS d,
                 COUNT(*)::int AS n
          FROM "User" u
          JOIN "membership_level" ml ON ml."code" = u."membershipLevel"
          WHERE ml."isSystem" = false AND u."createdAt" >= ${d14}
          GROUP BY 1
        `,
        db.$queryRaw<{ d: string; n: number }[]>`
          SELECT to_char(date_trunc('day', r."createdAt" + interval '8 hours'), 'YYYY-MM-DD') AS d,
                 COUNT(DISTINCT r."userId")::int AS n
          FROM usage_record r
          WHERE r."createdAt" >= ${d14} AND r."userId" IS NOT NULL
          GROUP BY 1
        `,
        db.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n
          FROM "User" u
          JOIN "membership_level" ml ON ml."code" = u."membershipLevel"
          WHERE ml."isSystem" = false AND u."createdAt" >= ${d7}
        `,
        db.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n
          FROM "User" u
          JOIN "membership_level" ml ON ml."code" = u."membershipLevel"
          WHERE ml."isSystem" = false
            AND u."createdAt" >= ${d7}
            AND EXISTS (
              SELECT 1 FROM pay_order o
              WHERE o."userId" = u.id AND o.status = 'paid'
            )
        `,
      ]);
      const regMap = new Map(regRows.map((r) => [r.d, n(r.n)]));
      const actMap = new Map(activeRows.map((r) => [r.d, n(r.n)]));
      const daily: DashboardMetrics["growth"]["daily"] = [];
      for (let i = 13; i >= 0; i--) {
        const key = shanghaiDateKey(shanghaiMidnight(-i).getTime());
        daily.push({
          date: key,
          label: `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`,
          registrations: regMap.get(key) ?? 0,
          activeUsers: actMap.get(key) ?? 0,
        });
      }
      return {
        daily,
        newUsers7d: n(new7Rows[0]?.n),
        newUsers7dPaid: n(new7PaidRows[0]?.n),
      };
    },
    { daily: [], newUsers7d: 0, newUsers7dPaid: 0 }
  );

  // ── 支付与充值 ──
  const payments = await safe(
    "payments",
    async () => {
      const [d24Rows, d7Rows, staleRows, packRows] = await Promise.all([
        db.$queryRaw<{ paid: number; cents: bigint; failed: number }[]>`
          SELECT
            COUNT(*) FILTER (WHERE status = 'paid')::int AS paid,
            COALESCE(SUM(CASE WHEN status = 'paid' THEN "amountCents" ELSE 0 END), 0)::bigint AS cents,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
          FROM pay_order
          WHERE "createdAt" >= ${since24h}
        `,
        db.$queryRaw<{ paid: number; cents: bigint; failed: number }[]>`
          SELECT
            COUNT(*) FILTER (WHERE status = 'paid')::int AS paid,
            COALESCE(SUM(CASE WHEN status = 'paid' THEN "amountCents" ELSE 0 END), 0)::bigint AS cents,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
          FROM pay_order
          WHERE "createdAt" >= ${since7d}
        `,
        db.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n
          FROM pay_order
          WHERE status = 'pending' AND "createdAt" < ${since30min}
        `,
        db.$queryRaw<{ name: string | null; orders: number; cents: bigint }[]>`
          SELECT p."packCode" AS name, COUNT(*)::int AS orders,
                 COALESCE(SUM(o."amountCents"), 0)::bigint AS cents
          FROM pay_order o
          JOIN credit_pack p ON p.id = o."packId"
          WHERE o.status = 'paid' AND COALESCE(o."paidAt", o."createdAt") >= ${since7d}
          GROUP BY p."packCode"
          ORDER BY cents DESC
          LIMIT 3
        `,
      ]);
      const d24 = d24Rows[0] || { paid: 0, cents: 0n, failed: 0 };
      const d7r = d7Rows[0] || { paid: 0, cents: 0n, failed: 0 };
      return {
        d24: { paidCount: n(d24.paid), paidCents: n(d24.cents), failedCount: n(d24.failed) },
        d7: { paidCount: n(d7r.paid), paidCents: n(d7r.cents), failedCount: n(d7r.failed) },
        pendingStale: n(staleRows[0]?.n),
        topPacks: packRows.map((r) => ({
          name: r.name || "未知套餐",
          orders: n(r.orders),
          cents: n(r.cents),
        })),
      };
    },
    {
      d24: { paidCount: 0, paidCents: 0, failedCount: 0 },
      d7: { paidCount: 0, paidCents: 0, failedCount: 0 },
      pendingStale: 0,
      topPacks: [],
    }
  );

  // ── 实验场运行 ──
  const playground = await safe(
    "playground",
    async () => {
      const [sessRows, msgRows, mediaRows, guestRows] = await Promise.all([
        db.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM playground_session WHERE "createdAt" >= ${today}
        `,
        db.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM playground_message WHERE "createdAt" >= ${today}
        `,
        db.$queryRaw<{ total: number; succeeded: number; failed: number }[]>`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
          FROM playground_media_task
          WHERE "createdAt" >= ${since24h}
        `,
        db.siteSetting.findMany({
          where: { key: { startsWith: "playground_guest:" } },
          select: { value: true },
        }),
      ]);
      const todayKey = shanghaiDateKey(today.getTime());
      let guestTrials = 0;
      let guestToday = 0;
      for (const row of guestRows) {
        try {
          const parsed = JSON.parse(row.value) as { count?: unknown; at?: unknown };
          const count = Number(parsed.count);
          if (Number.isFinite(count)) guestTrials += Math.max(0, Math.trunc(count));
          if (typeof parsed.at === "string") {
            const at = Date.parse(parsed.at);
            if (Number.isFinite(at) && shanghaiDateKey(at) === todayKey) guestToday++;
          }
        } catch {
          // 历史脏数据解析失败跳过，不能让接口 500
        }
      }
      const media = mediaRows[0] || { total: 0, succeeded: 0, failed: 0 };
      return {
        sessionsToday: n(sessRows[0]?.n),
        messagesToday: n(msgRows[0]?.n),
        media24h: { total: n(media.total), succeeded: n(media.succeeded), failed: n(media.failed) },
        guestKeys: guestRows.length,
        guestTrials,
        guestToday,
      };
    },
    { sessionsToday: 0, messagesToday: 0, media24h: { total: 0, succeeded: 0, failed: 0 }, guestKeys: 0, guestTrials: 0, guestToday: 0 }
  );

  // ── 待办 ──
  const todo = await safe(
    "todo",
    async () => {
      const [pendingPrompts, openTickets] = await Promise.all([
        db.prompt.count({ where: { status: "pending" } }),
        // 与后台「消息工单」队列同口径：会话根消息 + 待处理状态（open / pending）
        db.userMessage.count({
          where: {
            direction: "user_to_admin",
            msgType: "ticket",
            replyToId: null,
            ticketStatus: { in: ["open", "pending"] },
          },
        }),
      ]);
      return { pendingPrompts, openTickets, unackedAlerts: alerts.unacked };
    },
    { pendingPrompts: 0, openTickets: 0, unackedAlerts: 0 }
  );

  return {
    generatedAt: new Date().toISOString(),
    business: { today: businessToday, d7: business7d, d30: business30d },
    pool,
    queue,
    alerts,
    anomalies,
    growth,
    payments,
    playground,
    todo,
  };
}
