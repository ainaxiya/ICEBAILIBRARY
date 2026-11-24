"use client";

// 后台积分明细：按会员（userId）与变动类型筛选、分页浏览全站积分变动记录。
import { useCallback, useEffect, useState } from "react";
import Pagination from "@/components/Pagination";

type LedgerRow = {
  id: number;
  userId: number;
  username: string;
  changeAmount: number;
  balanceAfter: number;
  reason: string;
  refType: string | null;
  refId: string | null;
  source: string;
  createdAt: string;
};

const PAGE_SIZE = 20;

// 变动类型：入账 / 消费 / 退回 / 调账
const REASON_TEXT: Record<string, string> = {
  grant: "入账",
  consume: "消费",
  refund: "预扣退回",
  admin_adjust: "调账",
};
const REASON_BADGE: Record<string, string> = {
  grant: "bg-emerald-500/15 text-emerald-300",
  consume: "bg-indigo-500/15 text-indigo-300",
  refund: "bg-amber-500/15 text-amber-300",
  admin_adjust: "bg-zinc-700 text-zinc-300",
};

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : "—");
const selCls =
  "rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500";

export default function CreditLedgerAdmin() {
  // 会员 userId 输入框草稿态 + 已应用值
  const [userIdInput, setUserIdInput] = useState("");
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("all");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const ps = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), reason });
    if (userId) ps.set("userId", userId);
    try {
      const r = await fetch("/api/admin/credits/ledger?" + ps.toString());
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
  }, [page, userId, reason]);

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
            setPage(1);
          }}
          className="flex gap-2"
        >
          <input
            value={userIdInput}
            onChange={(e) => setUserIdInput(e.target.value)}
            placeholder="会员 userId…"
            className="min-w-[160px] rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 sm:min-w-[200px]"
          />
          <button className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">
            查询
          </button>
        </form>
        <select
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setPage(1);
          }}
          className={selCls}
        >
          <option value="all">全部类型</option>
          <option value="grant">入账</option>
          <option value="consume">消费</option>
          <option value="refund">退回</option>
          <option value="admin_adjust">调账</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-zinc-900/70 text-left text-xs text-zinc-500">
            <tr>
              <th className="px-4 py-3">时间</th>
              <th className="px-4 py-3">会员</th>
              <th className="px-4 py-3">变动</th>
              <th className="px-4 py-3">余额</th>
              <th className="px-4 py-3">类型</th>
              <th className="px-4 py-3">来源</th>
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
                <td className={`px-4 py-2.5 font-medium ${r.changeAmount >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                  {r.changeAmount >= 0 ? `+${r.changeAmount}` : r.changeAmount}
                </td>
                <td className="px-4 py-2.5 text-zinc-300">{r.balanceAfter}</td>
                <td className="px-4 py-2.5">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${REASON_BADGE[r.reason] || ""}`}>
                    {REASON_TEXT[r.reason] || r.reason}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className="text-xs text-zinc-400"
                    title={r.refType ? `${r.refType}${r.refId ? `:${r.refId}` : ""}` : undefined}
                  >
                    {r.source || "—"}
                  </span>
                </td>
              </tr>
            ))}
            {loaded && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-zinc-600">
                  暂无积分明细
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
