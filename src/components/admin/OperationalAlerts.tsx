"use client";

import { useCallback, useEffect, useState } from "react";

// ─── P6 后台：运营告警（告警列表 + 阈值配置 + 手动巡检 + 注册赠送开关） ───

type Alert = {
  id: number;
  alertType: string;
  level: string;
  message: string;
  payload: string;
  ackAt: string | null;
  createdAt: string;
};

type AlertsConfig = {
  creditPoolThreshold: number;
  marginRateThreshold: number;
  userBurst24hCredits: number;
};

type CheckMetrics = {
  poolRemaining: number;
  revenueMilli7d: number;
  costMilli7d: number;
  profitMilli7d: number;
  marginRate7d: number | null;
  burstUsers: number;
};

const TYPE_TEXT: Record<string, string> = {
  credit_pool: "积分池",
  gross_margin: "毛利",
  user_burst: "用户异常消耗",
};
const LEVEL_BADGE: Record<string, string> = {
  warn: "bg-amber-500/15 text-amber-300",
  critical: "bg-rose-500/15 text-rose-300",
};
const LEVEL_TEXT: Record<string, string> = {
  warn: "预警",
  critical: "严重",
};

function fmt(d: string | Date | null) {
  if (!d) return "—";
  const x = new Date(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

export default function OperationalAlerts() {
  const [items, setItems] = useState<Alert[] | null>(null);
  const [unackCount, setUnackCount] = useState(0);
  const [filter, setFilter] = useState<"all" | "unacked">("all");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // 巡检结果反馈
  const [checkMsg, setCheckMsg] = useState("");
  const [metrics, setMetrics] = useState<CheckMetrics | null>(null);

  // 阈值配置（SiteSetting key="alerts_config"）
  const [cfg, setCfg] = useState<AlertsConfig | null>(null);
  const [cfgSaved, setCfgSaved] = useState(false);

  // 注册赠送开关（SiteSetting key="credits_config"，默认关闭）
  const [trialEnabled, setTrialEnabled] = useState(false);
  const [trialCredits, setTrialCredits] = useState(0);
  const [trialSaved, setTrialSaved] = useState(false);

  const load = useCallback(async (f: "all" | "unacked") => {
    setItems(null);
    try {
      const r = await fetch(`/api/admin/alerts?ack=${f}`);
      const d = await r.json();
      if (r.ok) {
        setItems(d.items || []);
        setUnackCount(d.unackCount || 0);
        if (d.config) {
          setCfg(d.config);
        }
      } else {
        setError(d.error || "加载失败");
        setItems([]);
      }
    } catch {
      setError("加载失败，请稍后重试");
      setItems([]);
    }
  }, []);

  useEffect(() => {
    load(filter);
  }, [filter, load]);

  useEffect(() => {
    fetch("/api/admin/settings/credits")
      .then((r) => r.json())
      .then((d) => {
        setTrialEnabled(!!d.trialEnabled);
        setTrialCredits(Number(d.trialCredits) || 0);
      })
      .catch(() => {});
  }, []);

  const runCheck = async () => {
    if (busy) return;
    setBusy(true);
    setCheckMsg("");
    setError("");
    try {
      const r = await fetch("/api/admin/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check" }),
      });
      const d = await r.json();
      if (r.ok) {
        setCheckMsg(d.created?.length ? `巡检完成：新增 ${d.created.length} 条告警` : "巡检完成：未发现新问题");
        if (d.metrics) setMetrics(d.metrics);
        load(filter);
      } else {
        setError(d.error || "巡检失败");
      }
    } catch {
      setError("巡检失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const ackAlert = async (id: number) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/admin/alerts/${id}/ack`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) setError(d.error || "操作失败");
      load(filter);
    } catch {
      setError("操作失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const saveConfig = async () => {
    if (!cfg || busy) return;
    setBusy(true);
    setCfgSaved(false);
    setError("");
    try {
      const r = await fetch("/api/admin/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "saveConfig",
          config: {
            creditPoolThreshold: cfg.creditPoolThreshold,
            marginRateThreshold: cfg.marginRateThreshold,
            userBurst24hCredits: cfg.userBurst24hCredits,
          },
        }),
      });
      const d = await r.json();
      if (r.ok) {
        setCfg(d.config);
        setCfgSaved(true);
        setTimeout(() => setCfgSaved(false), 2000);
      } else {
        setError(d.error || "保存失败");
      }
    } catch {
      setError("保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const saveTrial = async () => {
    if (busy) return;
    setBusy(true);
    setTrialSaved(false);
    setError("");
    try {
      const r = await fetch("/api/admin/settings/credits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trialEnabled, trialCredits }),
      });
      const d = await r.json();
      if (r.ok) {
        setTrialEnabled(!!d.value?.trialEnabled);
        setTrialSaved(true);
        setTimeout(() => setTrialSaved(false), 2000);
      } else {
        setError(d.error || "保存失败");
      }
    } catch {
      setError("保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const th = "px-3 py-2.5 text-left text-xs font-medium text-zinc-500";
  const td = "px-3 py-2.5 text-sm text-zinc-300";
  const inputCls =
    "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none";
  const labelCls = "mb-1 block text-xs text-zinc-500";

  return (
    <div>
      {error && <p className="mb-3 text-sm text-rose-400">{error}</p>}

      {/* 巡检工具条 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(
          [
            ["all", "全部告警"],
            ["unacked", `未确认${unackCount ? `（${unackCount}）` : ""}`],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setFilter(k)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              filter === k ? "bg-zinc-800 text-emerald-300" : "text-zinc-500 hover:bg-zinc-800"
            }`}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={runCheck}
          disabled={busy}
          className="ml-auto rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "检查中…" : "立即检查"}
        </button>
      </div>

      {checkMsg && <p className="mb-2 text-sm text-emerald-400">{checkMsg}</p>}
      {metrics && (
        <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-400 lg:grid-cols-4">
          <span>积分池剩余：{metrics.poolRemaining}</span>
          <span>近 7 天收入：{metrics.revenueMilli7d} 毫积分</span>
          <span>近 7 天成本：{metrics.costMilli7d} 毫积分</span>
          <span>
            近 7 天毛利：{metrics.profitMilli7d} 毫积分
            {metrics.marginRate7d !== null && `（${(metrics.marginRate7d * 100).toFixed(1)}%）`}
          </span>
          <span>24h 异常消耗用户：{metrics.burstUsers}</span>
        </div>
      )}

      {/* 告警列表 */}
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        {items == null ? (
          <div className="p-6 text-center text-sm text-zinc-500">加载中…</div>
        ) : items.length === 0 ? (
          <div className="p-6 text-center text-sm text-zinc-500">暂无告警</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-zinc-900/60">
                <tr>
                  <th className={th}>级别</th>
                  <th className={th}>类型</th>
                  <th className={th}>内容</th>
                  <th className={th}>时间</th>
                  <th className={th}>状态</th>
                  <th className={th}>操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {items.map((a) => (
                  <tr key={a.id} className="hover:bg-zinc-900/40">
                    <td className={td}>
                      <span className={`rounded px-1.5 py-0.5 text-xs ${LEVEL_BADGE[a.level] || ""}`}>
                        {LEVEL_TEXT[a.level] || a.level}
                      </span>
                    </td>
                    <td className={`${td} text-xs`}>{TYPE_TEXT[a.alertType] || a.alertType}</td>
                    <td className={`${td} max-w-[420px]`}>{a.message}</td>
                    <td className={`${td} text-xs`}>{fmt(a.createdAt)}</td>
                    <td className={`${td} text-xs`}>
                      {a.ackAt ? (
                        <span className="text-zinc-500">已确认 {fmt(a.ackAt)}</span>
                      ) : (
                        <span className="text-amber-400">未确认</span>
                      )}
                    </td>
                    <td className={td}>
                      {!a.ackAt && (
                        <button
                          type="button"
                          onClick={() => ackAlert(a.id)}
                          disabled={busy}
                          className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-emerald-400 hover:border-emerald-500 disabled:opacity-50"
                        >
                          确认
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        {/* 阈值配置 */}
        <div className="rounded-xl border border-zinc-800 p-5">
          <h3 className="mb-3 text-sm font-semibold text-zinc-200">告警阈值配置</h3>
          {cfg && (
            <div className="space-y-3">
              <div>
                <label className={labelCls}>积分池剩余阈值（全站有效积分低于该值告警）</label>
                <input
                  type="number"
                  min={0}
                  value={cfg.creditPoolThreshold}
                  onChange={(e) => setCfg({ ...cfg, creditPoolThreshold: Math.max(0, parseInt(e.target.value) || 0) })}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>毛利率阈值（近 7 天低于该百分比告警）</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(cfg.marginRateThreshold * 1000) / 10}
                  onChange={(e) =>
                    setCfg({
                      ...cfg,
                      marginRateThreshold: Math.min(1, Math.max(0, (parseFloat(e.target.value) || 0) / 100)),
                    })
                  }
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>单用户 24 小时消耗阈值（积分）</label>
                <input
                  type="number"
                  min={0}
                  value={cfg.userBurst24hCredits}
                  onChange={(e) => setCfg({ ...cfg, userBurst24hCredits: Math.max(0, parseInt(e.target.value) || 0) })}
                  className={inputCls}
                />
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={saveConfig}
            disabled={busy || !cfg}
            className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            保存阈值
          </button>
          {cfgSaved && <span className="ml-3 text-sm text-emerald-400">已保存 ✓</span>}
          <p className="mt-2 text-xs text-zinc-600">
            本地开发无定时任务，巡检由「立即检查」手动触发；TODO：上线后接 cron 自动巡检。
          </p>
        </div>

        {/* 注册赠送开关 */}
        <div className="rounded-xl border border-zinc-800 p-5">
          <h3 className="mb-3 text-sm font-semibold text-zinc-200">注册赠送开关</h3>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={trialEnabled}
              onChange={(e) => setTrialEnabled(e.target.checked)}
            />
            开启注册赠送积分（默认关闭）
          </label>
          <div className="mt-3">
            <label className={labelCls}>每个新用户赠送积分</label>
            <input
              type="number"
              min={0}
              value={trialCredits}
              onChange={(e) => setTrialCredits(Math.max(0, parseInt(e.target.value) || 0))}
              className={inputCls}
            />
          </div>
          <button
            type="button"
            onClick={saveTrial}
            disabled={busy}
            className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            保存配置
          </button>
          {trialSaved && <span className="ml-3 text-sm text-emerald-400">已保存 ✓</span>}
          <p className="mt-2 text-xs text-zinc-600">
            支付代扣签约落地后一键开。开关仅对新注册用户生效（写 trial 类型积分发放记录），已注册用户不补发。
          </p>
        </div>
      </div>
    </div>
  );
}
