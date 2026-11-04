"use client";

// 后台使用记录管理：全站模型调用明细，按会员/通道/状态/关键词筛选、分页。
import { useCallback, useEffect, useState } from "react";
import Pagination from "@/components/Pagination";

type UsageRow = {
  id: number;
  userId: number;
  username: string;
  channel: string;
  keyPrefix: string | null;
  modelSnapshot: string | null;
  promptTokens: number;
  outputTokens: number;
  paidCredits: number;
  status: string;
  latencyMs: number | null;
  requestId: string | null;
  createdAt: string;
};

const PAGE_SIZE = 20;

const CHANNEL_TEXT: Record<string, string> = { onsite: "本站", apikey: "KEY" };
const USAGE_STATUS: Record<string, string> = { success: "成功", failed: "失败", blocked: "拦截" };
// 状态徽章配色参照会员中心 USAGE_BADGE 风格
const USAGE_BADGE: Record<string, string> = {
  success: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-rose-500/15 text-rose-300",
  blocked: "bg-amber-500/15 text-amber-300",
};

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : "—");
const selCls =
  "rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500";

export default function UsageRecordsAdmin() {
  // 会员 userId 与关键词 q 用草稿态 + 已应用值，避免每敲一个字就发请求
  const [userIdInput, setUserIdInput] = useState("");
  const [userId, setUserId] = useState("");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [channel, setChannel] = useState("all");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const ps = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), channel, status });
    if (userId) ps.set("userId", userId);
    if (q) ps.set("q", q);
    try {
      const r = await fetch("/api/admin/usage/records?" + ps.toString());
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(d.error || "加载失败");
        return;
      }
      setRows(d.items || []);
      setTotal(d.total || 0);
    } catch (e) {
      alert("加载失败：" + String(e));
    } finally {
      setLoaded(true);
    }
  }, [page, userId, q, channel, status]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setUserId(userIdInput.trim());
            setQ(qInput.trim());
            setPage(1);
          }}
          className="flex gap-2"
        >
          <input
            value={userIdInput}
            onChange={(e) => setUserIdInput(e.target.value)}
            placeholder="会员 userId…"
            className="min-w-[120px] rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
          />
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="模型 / requestId 搜索…"
            className="min-w-[160px] flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 sm:min-w-[220px]"
          />
          <button className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">
            查询
          </button>
        </form>
        <select
          value={channel}
          onChange={(e) => {
            setChannel(e.target.value);
            setPage(1);
          }}
          className={selCls}
        >
          <option value="all">全部通道</option>
          <option value="onsite">本站</option>
          <option value="apikey">KEY</option>
        </select>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className={selCls}
        >
          <option value="all">全部状态</option>
          <option value="success">成功</option>
          <option value="failed">失败</option>
          <option value="blocked">拦截</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="bg-zinc-900/70 text-left text-xs text-zinc-500">
            <tr>
              <th className="px-4 py-3">时间</th>
              <th className="px-4 py-3">会员</th>
              <th className="px-4 py-3">通道</th>
              <th className="px-4 py-3">Key</th>
              <th className="px-4 py-3">模型</th>
              <th className="px-4 py-3">用量（入 / 出）</th>
              <th className="px-4 py-3">扣分</th>
              <th className="px-4 py-3">状态</th>
              <th className="px-4 py-3">延迟</th>
              <th className="px-4 py-3">requestId</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-zinc-800/70 hover:bg-zinc-900/40">
                <td className="px-4 py-2.5 text-xs text-zinc-500">{fmt(r.createdAt)}</td>
                <td className="px-4 py-2.5">
                  <span className="font-medium text-zinc-200">{r.username}</span>
                  <span className="ml-1.5 text-xs text-zinc-600">#{r.userId}</span>
                </td>
                <td className="px-4 py-2.5 text-zinc-400">{CHANNEL_TEXT[r.channel] || r.channel}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-zinc-500">{r.keyPrefix || "—"}</td>
                <td className="px-4 py-2.5 text-zinc-300">{r.modelSnapshot || "—"}</td>
                <td className="px-4 py-2.5 text-xs text-zinc-400">
                  {r.promptTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}
                </td>
                <td className="px-4 py-2.5 text-zinc-300">{r.paidCredits}</td>
                <td className="px-4 py-2.5">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${USAGE_BADGE[r.status] || ""}`}>
                    {USAGE_STATUS[r.status] || r.status}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-500">
                  {r.latencyMs === null ? "—" : `${r.latencyMs} ms`}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-zinc-600">{r.requestId || "—"}</td>
              </tr>
            ))}
            {loaded && rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-10 text-center text-sm text-zinc-600">
                  暂无使用记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPage={(n) => setPage(n)} />
    </div>
  );
}
