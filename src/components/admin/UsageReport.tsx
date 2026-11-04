"use client";

import { useCallback, useEffect, useState } from "react";

type Row = {
  bucket: string;
  date: string | null;
  modelId: number | null;
  modelName: string | null;
  channel?: string | null;
  calls: number;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  paidCredits: number;
  costMilli: number;
  revenueMilli: number;
  profitMilli: number;
  profitRate: number;
  successRate: number;
  avgLatencyMs: number | null;
};

type Report = {
  groupBy: string;
  dateFrom: string;
  dateTo: string;
  items: Row[];
  totals: {
    calls: number;
    promptTokens: number;
    outputTokens: number;
    totalTokens: number;
    paidCredits: number;
    costMilli: number;
    revenueMilli: number;
    profitMilli: number;
    profitRate: number;
  };
};

type ModelOpt = { id: number; displayName: string; name: string };

const inputCls =
  "rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-indigo-500";
const btnCls =
  "rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700";
const thCls = "border-b border-zinc-800 px-3 py-2 text-left text-xs text-zinc-400";
const tdCls = "border-b border-zinc-800/60 px-3 py-2 text-sm text-zinc-300";

// 毫积分 → 积分（2 位小数）
const milli = (v: number) => (v / 1000).toFixed(2);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export default function UsageReport() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 29 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const [dateFrom, setDateFrom] = useState(monthAgo);
  const [dateTo, setDateTo] = useState(today);
  const [modelId, setModelId] = useState(0);
  const [groupBy, setGroupBy] = useState<"day" | "model">("day");
  // 通道页签：本站消费 / KEY 消费 / 全部
  const [channel, setChannel] = useState<"all" | "onsite" | "apikey">("all");
  const [models, setModels] = useState<ModelOpt[]>([]);
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/models/models")
      .then((r) => r.json())
      .then((d) => setModels(d.models || []))
      .catch(() => {});
  }, []);

  const load = useCallback(async (channelOverride?: "all" | "onsite" | "apikey") => {
    setLoading(true);
    setMsg(null);
    try {
      const qs = new URLSearchParams({ groupBy, dateFrom, dateTo, channel: channelOverride ?? channel });
      if (modelId) qs.set("modelId", String(modelId));
      const r = await fetch(`/api/admin/reports/usage?${qs.toString()}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "加载失败");
      setData(d);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [groupBy, dateFrom, dateTo, modelId, channel]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {/* 通道页签：切换时带 channel 参数重新请求 */}
      <div className="mb-4 flex flex-wrap gap-2">
        {(
          [
            { key: "onsite", label: "本站消费报表" },
            { key: "apikey", label: "KEY 消费报表" },
            { key: "all", label: "全部" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              if (channel === t.key) return;
              setChannel(t.key);
              load(t.key);
            }}
            className={`rounded-lg px-4 py-1.5 text-sm transition ${
              channel === t.key
                ? "bg-emerald-600 font-medium text-white"
                : "border border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs text-zinc-500">开始日期</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-zinc-500">结束日期</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-zinc-500">模型</label>
          <select value={modelId} onChange={(e) => setModelId(Number(e.target.value))} className={inputCls}>
            <option value={0}>全部模型</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}（{m.name}）
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-zinc-500">聚合方式</label>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as "day" | "model")} className={inputCls}>
            <option value="day">按日聚合</option>
            <option value="model">按模型聚合</option>
          </select>
        </div>
        <button type="button" onClick={() => load()} className={btnCls} disabled={loading}>
          {loading ? "查询中…" : "查询"}
        </button>
      </div>

      {msg && <p className="mb-3 text-sm text-red-400">{msg}</p>}

      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/50">
        <table className="w-full min-w-[960px]">
          <thead>
            <tr>
              <th className={thCls}>日期</th>
              <th className={thCls}>模型</th>
              <th className={thCls}>调用数</th>
              <th className={thCls}>Tokens（入/出）</th>
              <th className={thCls}>用户扣分</th>
              <th className={thCls}>内部成本</th>
              <th className={thCls}>毛利</th>
              <th className={thCls}>毛利率</th>
              <th className={thCls}>成功率</th>
              <th className={thCls}>平均延迟</th>
            </tr>
          </thead>
          <tbody>
            {(data?.items || []).map((r) => (
              <tr key={r.bucket} className="hover:bg-zinc-800/40">
                <td className={tdCls}>{r.date || `${data?.dateFrom} ~ ${data?.dateTo}`}</td>
                <td className={tdCls}>{r.modelName || (r.modelId ? `模型 #${r.modelId}` : "全部模型")}</td>
                <td className={tdCls}>{r.calls.toLocaleString()}</td>
                <td className={tdCls}>
                  {r.promptTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}
                </td>
                <td className={tdCls}>{r.paidCredits.toLocaleString()} 积分</td>
                <td className={tdCls}>{milli(r.costMilli)} 积分</td>
                <td className={`${tdCls} ${r.profitMilli >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {milli(r.profitMilli)} 积分
                </td>
                <td className={tdCls}>{pct(r.profitRate)}</td>
                <td className={tdCls}>{pct(r.successRate)}</td>
                <td className={tdCls}>{r.avgLatencyMs === null ? "-" : `${r.avgLatencyMs} ms`}</td>
              </tr>
            ))}
            {data && data.items.length === 0 && (
              <tr>
                <td className={`${tdCls} text-center text-zinc-500`} colSpan={10}>
                  该时间范围内暂无调用记录
                </td>
              </tr>
            )}
          </tbody>
          {data && data.items.length > 0 && (
            <tfoot>
              <tr className="bg-zinc-800/60">
                <td className={`${tdCls} font-medium`}>合计</td>
                <td className={tdCls}>-</td>
                <td className={`${tdCls} font-medium`}>{data.totals.calls.toLocaleString()}</td>
                <td className={tdCls}>
                  {data.totals.promptTokens.toLocaleString()} / {data.totals.outputTokens.toLocaleString()}
                </td>
                <td className={`${tdCls} font-medium`}>{data.totals.paidCredits.toLocaleString()} 积分</td>
                <td className={tdCls}>{milli(data.totals.costMilli)} 积分</td>
                <td className={`${tdCls} font-medium text-emerald-400`}>{milli(data.totals.profitMilli)} 积分</td>
                <td className={tdCls}>{pct(data.totals.profitRate)}</td>
                <td className={tdCls}>-</td>
                <td className={tdCls}>-</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p className="mt-3 text-xs text-zinc-500">
        口径：毛利（毫积分）= Σ用户扣分×1000 − Σ内部成本(cost_milli)，展示时换算为积分；成本/毛利仅内部核算，不影响用户余额。
      </p>
    </div>
  );
}
