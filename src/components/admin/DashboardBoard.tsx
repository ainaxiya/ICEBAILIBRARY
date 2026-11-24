"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ADMIN_BASE } from "@/lib/admin-path";
import type { DashboardMetrics } from "@/lib/dashboard-metrics";

// ─── 后台仪表盘：运营与排障 ───
// 服务端 SSR 出首屏（props.initial），挂载后每 60 秒单请求刷新全部区块；
// 页面不可见时跳过刷新，失败保留旧数据并在顶栏提示。

type WindowMetrics = DashboardMetrics["business"]["today"];

const nf = (v: number) => v.toLocaleString("zh-CN");
const yuan = (cents: number) =>
  (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fromMilli = (milli: number) =>
  (milli / 1000).toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const pct1 = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

const CARD = "rounded-xl border border-zinc-800 bg-zinc-900/60 p-4";
const CARD_TITLE = "text-sm font-medium text-zinc-200";
const SUB = "mt-0.5 text-xs text-zinc-500";
const LABEL = "text-xs text-zinc-500";
const VALUE = "text-xl font-bold";

const ALERT_TYPE_LABEL: Record<string, string> = {
  credit_pool: "积分池",
  gross_margin: "毛利",
  pay_fail: "支付异常",
  register_burst: "注册异常",
  usage_invalid: "用量异常",
  reconcile_failed: "对账失败",
};

function levelText(level: string) {
  return level === "critical" ? "严重" : "警告";
}
function levelCls(level: string) {
  return level === "critical"
    ? "bg-rose-500/20 text-rose-300"
    : "bg-amber-500/20 text-amber-300";
}

function Metric({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div>
      <div className={`${VALUE} ${cls ?? "text-zinc-100"}`}>{value}</div>
      <div className={LABEL}>{label}</div>
    </div>
  );
}

function BusinessColumn({ title, w }: { title: string; w: WindowMetrics }) {
  return (
    <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/30 p-3">
      <h3 className="text-xs font-medium text-zinc-400">{title}</h3>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
        <Metric label="现金充值（元）" value={yuan(w.revenueCents)} cls="text-emerald-400" />
        <Metric label="积分发放" value={nf(w.creditsIssued)} cls="text-sky-400" />
        <Metric label="积分消耗" value={nf(w.creditsSpent)} cls="text-amber-400" />
        <Metric label="内部成本（积分）" value={fromMilli(w.costMilli)} cls="text-violet-400" />
        <Metric label="毛利（积分）" value={fromMilli(w.profitMilli)} cls={w.profitMilli < 0 ? "text-rose-400" : "text-cyan-300"} />
        <Metric label="毛利率" value={pct1(w.marginRate)} cls={w.marginRate != null && w.marginRate < 0 ? "text-rose-400" : "text-zinc-100"} />
      </div>
    </div>
  );
}

export default function DashboardBoard({ initial }: { initial: DashboardMetrics }) {
  const [data, setData] = useState<DashboardMetrics>(initial);
  const [updatedAt, setUpdatedAt] = useState<Date>(new Date(initial.generatedAt));
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (silent: boolean) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/admin/dashboard/metrics", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as DashboardMetrics;
      setData(next);
      setUpdatedAt(new Date(next.generatedAt));
      setError(false);
    } catch (e) {
      console.error("[DashboardBoard] 刷新失败：", e);
      setError(true);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hidden) return;
      void refresh(true);
    }, 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const { business, pool, queue, alerts, anomalies, growth, payments, playground, todo } = data;

  const bucketRows = [
    { label: "0 积分", count: pool.buckets.zero, cls: "bg-zinc-500/70" },
    { label: "1 – 1,000", count: pool.buckets.low, cls: "bg-amber-500/70" },
    { label: "1,001 – 10,000", count: pool.buckets.mid, cls: "bg-sky-500/70" },
    { label: "10,001 – 100,000", count: pool.buckets.high, cls: "bg-emerald-500/70" },
    { label: "100,000 以上", count: pool.buckets.vip, cls: "bg-violet-500/70" },
  ];
  const bucketTotal = bucketRows.reduce((s, b) => s + b.count, 0);

  const growthMax = Math.max(
    1,
    ...growth.daily.map((d) => Math.max(d.registrations, d.activeUsers))
  );
  const paidConversion =
    growth.newUsers7d > 0 ? growth.newUsers7dPaid / growth.newUsers7d : null;

  return (
    <div className="space-y-4">
      {/* 顶栏：刷新控制 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-zinc-300">运营与排障</h2>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          {error && <span className="text-rose-400">刷新失败，显示上次数据</span>}
          <span>更新于 {updatedAt.toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}</span>
          <button
            type="button"
            onClick={() => void refresh(false)}
            disabled={loading}
            className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 transition hover:border-emerald-600 hover:text-emerald-300 disabled:opacity-50"
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      {/* 1. 待办 */}
      <div className="mb-2 mt-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className={CARD_TITLE}>待办</h3>
        <span className={LABEL}>待处理事项，点击进入对应队列</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Link
          href={`${ADMIN_BASE}/prompts?status=pending`}
          className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition hover:border-emerald-700/50"
        >
          <div className="text-2xl font-bold text-amber-400">{nf(todo.pendingPrompts)}</div>
          <div className="mt-1 text-xs text-zinc-500">待审提示词</div>
        </Link>
        <Link
          href={`${ADMIN_BASE}/messages`}
          className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition hover:border-emerald-700/50"
        >
          <div className="text-2xl font-bold text-sky-400">{nf(todo.openTickets)}</div>
          <div className="mt-1 text-xs text-zinc-500">待回工单</div>
        </Link>
        <Link
          href={`${ADMIN_BASE}/alerts`}
          className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition hover:border-emerald-700/50"
        >
          <div className={`text-2xl font-bold ${todo.unackedAlerts > 0 ? "text-rose-400" : "text-zinc-300"}`}>
            {nf(todo.unackedAlerts)}
          </div>
          <div className="mt-1 text-xs text-zinc-500">未确认告警</div>
        </Link>
      </div>

      {/* 2. 经营概览 */}
      <section className={CARD}>
        <div className="flex items-baseline justify-between">
          <h3 className={CARD_TITLE}>经营概览</h3>
          <span className={LABEL}>按 Asia/Shanghai 自然日切分</span>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          <BusinessColumn title="今日" w={business.today} />
          <BusinessColumn title="近 7 天" w={business.d7} />
          <BusinessColumn title="近 30 天" w={business.d30} />
        </div>
      </section>

      {/* 3. 积分池健康 + 4. 队列与失败率 */}
      <div className="grid gap-3 lg:grid-cols-3">
        <section className={CARD}>
          <h3 className={CARD_TITLE}>积分池健康</h3>
          <p className={SUB}>按会员有效余额分桶 · 共 {nf(bucketTotal)} 人</p>
          <div className="mt-3 flex items-baseline gap-3">
            <span className="text-2xl font-bold text-cyan-300">
              {pool.supportDays == null ? "—" : nf(pool.supportDays)}
            </span>
            <span className="text-xs text-zinc-500">预计可用天数</span>
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">全站有效余额 {nf(pool.totalBalance)} 积分</p>
          <div className="mt-3 space-y-2">
            {bucketRows.map((b) => {
              const p = bucketTotal > 0 ? Math.round((b.count / bucketTotal) * 1000) / 10 : 0;
              return (
                <div key={b.label}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-400">{b.label}</span>
                    <span className="text-zinc-300">
                      {nf(b.count)}
                      <span className="ml-1 text-zinc-600">{p}%</span>
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded bg-zinc-800">
                    <div className={`h-full rounded ${b.cls}`} style={{ width: `${p}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-zinc-800 pt-2 text-xs text-zinc-500">
            <p>7 天内到期 <span className="text-amber-400">{nf(pool.expiring7d)}</span> 积分</p>
            <p>30 天内到期 <span className="text-amber-400">{nf(pool.expiring30d)}</span> 积分</p>
            <p>7 天发放 <span className="text-emerald-400">{nf(pool.netFlow7d.grant)}</span></p>
            <p>7 天消耗 <span className="text-rose-400">{nf(pool.netFlow7d.consume)}</span></p>
            <p>7 天退款 <span className="text-sky-400">{nf(pool.netFlow7d.refund)}</span></p>
            <p>7 天调整 <span className="text-violet-400">{nf(pool.netFlow7d.adjust)}</span></p>
            <p className="col-span-2">
              7 天净流入 <span className={pool.netFlow7d.net < 0 ? "text-rose-400" : "text-emerald-400"}>{nf(pool.netFlow7d.net)}</span>
            </p>
          </div>
        </section>

        <section className={`${CARD} lg:col-span-2`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className={CARD_TITLE}>任务队列与失败率</h3>
            <div className="flex items-center gap-2 text-xs">
              <span
                className={`rounded px-1.5 py-0.5 ${queue.workerOnline ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"}`}
              >
                Worker {queue.workerOnline ? "在线" : "离线"}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 ${queue.redisOk ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"}`}
              >
                Redis {queue.redisOk ? "正常" : "异常"}
              </span>
              <span className="text-zinc-500">
                在跑 {nf(queue.inflight)}
                {queue.lastSeenAt && ` · 心跳 ${new Date(queue.lastSeenAt).toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`}
              </span>
            </div>
          </div>

          <div className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {queue.channels.length === 0 ? (
              <p className="text-xs text-zinc-600">—</p>
            ) : (
              queue.channels.map((c) => (
                <div key={c.key} className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-1.5 text-zinc-400">
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${c.online ? "bg-emerald-400" : "bg-rose-400"}`} />
                    {c.label}
                  </span>
                  <span className="text-zinc-300">
                    {nf(c.inflight)} / {nf(c.concurrency)}
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-zinc-800 pt-3 sm:grid-cols-4">
            <Metric
              label="媒体任务 24h 成功率"
              value={pct1(queue.media24h.successRate)}
              cls="text-emerald-400"
            />
            <Metric label="媒体失败（24h）" value={nf(queue.media24h.failed)} cls="text-rose-400" />
            <Metric label="卡死任务" value={nf(queue.stuckMedia)} cls={queue.stuckMedia > 0 ? "text-rose-400" : "text-zinc-100"} />
            <Metric
              label="对账待重试 / 失败"
              value={`${nf(queue.reconcile.pending)} / ${nf(queue.reconcile.failed)}`}
              cls={queue.reconcile.failed > 0 ? "text-rose-400" : "text-zinc-100"}
            />
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            视频任务 24h：总 {nf(queue.video24h.total)} · 成功 {nf(queue.video24h.succeeded)} · 失败{" "}
            {nf(queue.video24h.failed)} · 在跑 {nf(queue.video24h.running)} · 排队 {nf(queue.video24h.queued)}
          </p>
        </section>
      </div>

      {/* 5. 未确认告警 + 6. 异常会员 + 7. 注册与活跃 */}
      <div className="grid gap-3 lg:grid-cols-3">
        <section className={CARD}>
          <div className="flex items-baseline justify-between">
            <h3 className={CARD_TITLE}>未确认告警</h3>
            <span className={`text-lg font-bold ${alerts.unacked > 0 ? "text-rose-400" : "text-zinc-300"}`}>
              {nf(alerts.unacked)}
            </span>
          </div>
          <p className={SUB}>
            {alerts.lastCheckedAt
              ? `最近一条告警 ${new Date(alerts.lastCheckedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`
              : "暂无告警记录"}
          </p>
          {alerts.recent.length === 0 ? (
            <p className="py-6 text-center text-xs text-zinc-600">—</p>
          ) : (
            <div className="mt-2 divide-y divide-zinc-800/70">
              {alerts.recent.map((a) => (
                <div key={a.id} className="py-2">
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className={`rounded px-1.5 py-0.5 ${levelCls(a.level)}`}>{levelText(a.level)}</span>
                    <span className="text-zinc-400">{ALERT_TYPE_LABEL[a.alertType] || a.alertType}</span>
                    <span className="ml-auto text-zinc-600">
                      {new Date(a.createdAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-zinc-300">{a.message}</p>
                </div>
              ))}
            </div>
          )}
          <Link href={`${ADMIN_BASE}/alerts`} className="mt-2 inline-block text-xs text-emerald-400 hover:underline">
            去告警页
          </Link>
        </section>

        <section className={CARD}>
          <h3 className={CARD_TITLE}>异常会员</h3>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-lg font-bold text-amber-400">{nf(anomalies.zeroBalanceActive)}</div>
              <div className="text-xs text-zinc-500">0 余额仍活跃</div>
            </div>
            <div>
              <div className="text-lg font-bold text-rose-400">{nf(anomalies.reconcileUsers)}</div>
              <div className="text-xs text-zinc-500">对账待处理</div>
            </div>
            <div>
              <div className="text-lg font-bold text-zinc-300">{nf(anomalies.banned)}</div>
              <div className="text-xs text-zinc-500">封禁 / 禁言 {nf(anomalies.commentBanned)}</div>
            </div>
          </div>
          <p className="mt-3 border-t border-zinc-800 pt-2 text-xs text-zinc-500">近 24h 消耗 Top10</p>
          {anomalies.topSpenders.length === 0 ? (
            <p className="py-4 text-center text-xs text-zinc-600">—</p>
          ) : (
            <div className="mt-1 space-y-1">
              {anomalies.topSpenders.map((s) => (
                <div key={s.userId} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 truncate text-zinc-300">{s.name}</span>
                  <span className="text-zinc-500">{nf(s.calls)} 次</span>
                  <span className="w-16 text-right text-amber-400">{nf(s.credits)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className={CARD}>
          <div className="flex items-baseline justify-between">
            <h3 className={CARD_TITLE}>注册与活跃趋势</h3>
            <span className={LABEL}>近 14 天</span>
          </div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="text-2xl font-bold text-fuchsia-400">{nf(growth.newUsers7d)}</span>
            <span className="text-xs text-zinc-500">
              7 天新注册 · 付费 {nf(growth.newUsers7dPaid)}（{pct1(paidConversion)}）
            </span>
          </div>
          {growth.daily.length === 0 ? (
            <p className="py-8 text-center text-xs text-zinc-600">—</p>
          ) : (
            <div className="mt-3 flex h-24 items-end gap-1">
              {growth.daily.map((d) => (
                <div
                  key={d.date}
                  className="flex flex-1 items-end justify-center gap-px"
                  title={`${d.date}：注册 ${d.registrations} · 活跃 ${d.activeUsers}`}
                >
                  <div
                    className="w-1/2 rounded-sm bg-fuchsia-500/70"
                    style={{ height: `${Math.max(2, (d.registrations / growthMax) * 100)}%` }}
                  />
                  <div
                    className="w-1/2 rounded-sm bg-sky-500/60"
                    style={{ height: `${Math.max(2, (d.activeUsers / growthMax) * 100)}%` }}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 flex items-center justify-between text-xs text-zinc-600">
            <span className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-sm bg-fuchsia-500/70" /> 注册
              <span className="ml-2 inline-block h-1.5 w-1.5 rounded-sm bg-sky-500/60" /> 活跃
            </span>
            <span>
              {growth.daily[0]?.label} – {growth.daily[growth.daily.length - 1]?.label}
            </span>
          </div>
        </section>
      </div>

      {/* 8. 支付与充值 + 9. 实验场运行 */}
      <div className="grid gap-3 lg:grid-cols-3">
        <section className={`${CARD} lg:col-span-2`}>
          <h3 className={CARD_TITLE}>支付与充值</h3>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/30 p-3">
              <div className="text-xs text-zinc-400">近 24 小时</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Metric label="成功笔数" value={nf(payments.d24.paidCount)} cls="text-emerald-400" />
                <Metric label="成功金额（元）" value={yuan(payments.d24.paidCents)} cls="text-emerald-400" />
              </div>
              <p className="mt-2 text-xs text-zinc-500">失败 {nf(payments.d24.failedCount)} 笔</p>
            </div>
            <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/30 p-3">
              <div className="text-xs text-zinc-400">近 7 天</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Metric label="成功笔数" value={nf(payments.d7.paidCount)} cls="text-emerald-400" />
                <Metric label="成功金额（元）" value={yuan(payments.d7.paidCents)} cls="text-emerald-400" />
              </div>
              <p className="mt-2 text-xs text-zinc-500">失败 {nf(payments.d7.failedCount)} 笔</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t border-zinc-800 pt-2 text-xs text-zinc-500">
            <span>
              悬挂待支付（&gt;30 分钟） <span className={payments.pendingStale > 0 ? "text-rose-400" : "text-zinc-300"}>{nf(payments.pendingStale)}</span> 笔
            </span>
            <span>近 7 天套餐 Top3：</span>
            {payments.topPacks.length === 0 ? (
              <span className="text-zinc-600">—</span>
            ) : (
              payments.topPacks.map((p) => (
                <span key={p.name} className="text-zinc-300">
                  {p.name} <span className="text-zinc-500">{nf(p.orders)} 笔 / ¥{yuan(p.cents)}</span>
                </span>
              ))
            )}
          </div>
        </section>

        <section className={CARD}>
          <h3 className={CARD_TITLE}>实验场运行</h3>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Metric label="今日会话" value={nf(playground.sessionsToday)} cls="text-sky-400" />
            <Metric label="今日消息" value={nf(playground.messagesToday)} cls="text-cyan-300" />
            <Metric
              label="媒体成功率（24h）"
              value={pct1(playground.media24h.total > 0 ? playground.media24h.succeeded / playground.media24h.total : null)}
              cls="text-emerald-400"
            />
            <Metric label="媒体失败（24h）" value={nf(playground.media24h.failed)} cls="text-rose-400" />
            <Metric label="游客试玩人数" value={nf(playground.guestKeys)} cls="text-violet-400" />
            <Metric label="累计试玩次数" value={nf(playground.guestTrials)} cls="text-zinc-100" />
          </div>
          <p className="mt-2 border-t border-zinc-800 pt-2 text-xs text-zinc-500">
            今日游客试玩 <span className="text-violet-400">{nf(playground.guestToday)}</span> 人
          </p>
        </section>
      </div>
    </div>
  );
}
