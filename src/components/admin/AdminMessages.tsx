"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ADMIN_BASE } from "@/lib/admin-path";

// ─── v0.92 #4 后台：消息·工单（工单队列 + 客服式详情页 + 群发/单发通知） ───

type Ticket = {
  id: string;
  userId: number;
  user: { id: number; username: string; nickname: string | null };
  subject: string | null;
  body: string;
  ticketStatus: string | null;
  createdAt: string;
  lastBody: string;
  lastAt: string;
  replyCount: number;
  replyBy: string | null;
  newMsgCount: number;
};

// P6 群发历史批次（按 batchId 聚合）
type Batch = {
  batchId: string;
  count: number;
  subject: string | null;
  preview: string;
  sentAt: string | null;
};

const STATUS_BADGE: Record<string, string> = {
  open: "bg-amber-500/15 text-amber-300",
  pending: "bg-rose-500/15 text-rose-300",
  replied: "bg-emerald-500/15 text-emerald-300",
  closed: "bg-zinc-700 text-zinc-400",
};
const STATUS_TEXT: Record<string, string> = {
  open: "新工单需处理",
  pending: "新的消息需处理",
  replied: "已回复过此工单",
  closed: "已关闭",
};

function fmt(d: string | Date | null) {
  if (!d) return "—";
  const x = new Date(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

const PAGE_SIZE = 20;

export default function AdminMessages() {
  const [section, setSection] = useState<"tickets" | "broadcast">("tickets");

  // 工单队列
  const [status, setStatus] = useState<"open" | "pending" | "replied" | "closed" | "all">("open");
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  // 批量选择（工单队列复选框选中项）
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 群发（P6 人群筛选：全部 / 指定 ID / 按注册时间 / 按余额区间）
  const [bcSubject, setBcSubject] = useState("");
  const [bcBody, setBcBody] = useState("");
  const [bcTarget, setBcTarget] = useState<"all" | "users" | "registered" | "balance">("all");
  const [bcUserIds, setBcUserIds] = useState("");
  const [bcRegFrom, setBcRegFrom] = useState("");
  const [bcRegTo, setBcRegTo] = useState("");
  const [bcBalMin, setBcBalMin] = useState("");
  const [bcBalMax, setBcBalMax] = useState("");
  const [bcResult, setBcResult] = useState("");
  // 群发历史批次
  const [batches, setBatches] = useState<Batch[] | null>(null);
  // 单发
  const [nUserId, setNUserId] = useState("");
  const [nSubject, setNSubject] = useState("");
  const [nBody, setNBody] = useState("");
  const [nResult, setNResult] = useState("");

  const loadTickets = useCallback(async (st: string, pg: number) => {
    setTickets(null);
    try {
      const r = await fetch(`/api/admin/messages?status=${st}&page=${pg}`);
      const d = await r.json();
      if (r.ok) {
        setTickets(d.tickets || []);
        setTotal(d.total || 0);
        setPage(pg);
      } else {
        setError(d.error || "加载失败");
        setTickets([]);
      }
    } catch {
      setError("加载失败，请稍后重试");
      setTickets([]);
    }
  }, []);

  useEffect(() => {
    loadTickets(status, 1);
  }, [status, loadTickets]);

  // 群发历史批次（进入群发 Tab / 发送后刷新）
  const loadBatches = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/messages/batches");
      const d = await r.json();
      if (r.ok) setBatches(d.batches || []);
    } catch {
      setBatches([]);
    }
  }, []);

  useEffect(() => {
    if (section === "broadcast") loadBatches();
  }, [section, loadBatches]);

  const sendBroadcast = async () => {
    if (busy) return;
    setBusy(true);
    setBcResult("");
    setError("");
    try {
      const userIds = bcUserIds
        .split(/[,，\s]+/)
        .map((s) => parseInt(s))
        .filter((n) => Number.isInteger(n) && n > 0);
      const r = await fetch("/api/admin/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "broadcast",
          subject: bcSubject.trim(),
          body: bcBody.trim(),
          target: bcTarget,
          userIds,
          registeredFrom: bcRegFrom.trim(),
          registeredTo: bcRegTo.trim(),
          balanceMin: bcBalMin.trim(),
          balanceMax: bcBalMax.trim(),
        }),
      });
      const d = await r.json();
      if (r.ok) {
        setBcResult(`发送成功：批次 ${d.batchId}，投递 ${d.count} 条`);
        setBcSubject("");
        setBcBody("");
        setBcUserIds("");
        loadBatches();
      } else {
        setError(d.error || "发送失败");
      }
    } catch {
      setError("发送失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const sendNotice = async () => {
    if (busy) return;
    setBusy(true);
    setNResult("");
    setError("");
    try {
      const r = await fetch("/api/admin/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "notice",
          userId: parseInt(nUserId) || 0,
          subject: nSubject.trim(),
          body: nBody.trim(),
        }),
      });
      const d = await r.json();
      if (r.ok) {
        setNResult(`发送成功：消息 #${d.message.id} → 用户 ${d.message.userId}`);
        setNUserId("");
        setNSubject("");
        setNBody("");
      } else {
        setError(d.error || "发送失败");
      }
    } catch {
      setError("发送失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  // ── 批量关闭 / 批量删除工单会话 ──
  const toggleSel = (id: string) =>
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const runBatch = async (op: "close" | "delete") => {
    if (sel.length === 0 || busy) return;
    if (op === "delete" && !confirm(`确定删除选中的 ${sel.length} 个工单会话吗？将连同全部回复一并删除，不可恢复。`)) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/admin/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "batch", op, threadIds: sel }),
      });
      const d = await r.json();
      if (r.ok) {
        setSel([]);
        loadTickets(status, page);
      } else {
        setError(d.error || "操作失败");
      }
    } catch {
      setError("操作失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const th = "px-3 py-2.5 text-left text-xs font-medium text-zinc-500";
  const td = "px-3 py-2.5 text-sm text-zinc-300";
  const inputCls =
    "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none";

  return (
    <div>
      <div className="mb-4 flex gap-1.5">
        {(
          [
            ["tickets", "工单队列"],
            ["broadcast", "消息群发"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setSection(k)}
            className={`rounded-lg px-4 py-2 text-sm ${
              section === k ? "bg-emerald-600/20 text-emerald-300" : "text-zinc-400 hover:bg-zinc-800"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p className="mb-3 text-sm text-rose-400">{error}</p>}

      {/* ── 工单队列 ── */}
      {section === "tickets" && (
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            {(
              [
                ["open", "新工单需处理"],
                ["pending", "新的消息需处理"],
                ["replied", "已回复过此工单"],
                ["closed", "已关闭"],
                ["all", "全部"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => { setStatus(k); setSel([]); }}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  status === k ? "bg-zinc-800 text-emerald-300" : "text-zinc-500 hover:bg-zinc-800"
                }`}
              >
                {label}
              </button>
            ))}
            <span className="ml-auto text-xs text-zinc-500">共 {total} 条</span>
          </div>

          {/* 批量操作条 */}
          {tickets != null && tickets.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-zinc-500">已选 {sel.length} 项</span>
              <button
                type="button"
                onClick={() => runBatch("close")}
                disabled={busy || sel.length === 0}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              >
                批量关闭
              </button>
              <button
                type="button"
                onClick={() => runBatch("delete")}
                disabled={busy || sel.length === 0}
                className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-900/40 disabled:opacity-50"
              >
                批量删除
              </button>
            </div>
          )}

          <div className="overflow-hidden rounded-xl border border-zinc-800">
            {tickets == null ? (
              <div className="p-6 text-center text-sm text-zinc-500">加载中…</div>
            ) : tickets.length === 0 ? (
              <div className="p-6 text-center text-sm text-zinc-500">暂无工单</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-zinc-900/60">
                    <tr>
                      <th className={th}>
                        <input
                          type="checkbox"
                          checked={tickets.length > 0 && tickets.every((tk) => sel.includes(tk.id))}
                          onChange={() =>
                            setSel(tickets.every((tk) => sel.includes(tk.id)) ? [] : tickets.map((tk) => tk.id))
                          }
                        />
                      </th>
                      <th className={th}>问题类型</th>
                      <th className={th}>会员账号</th>
                      <th className={th}>昵称</th>
                      <th className={th}>状态</th>
                      <th className={th}>消息更新时间</th>
                      <th className={th}>创建时间</th>
                      <th className={th}>回复人</th>
                      <th className={th}>操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {tickets.map((tk) => (
                      <tr key={tk.id} className="hover:bg-zinc-900/40">
                        <td className={td}>
                          <input type="checkbox" checked={sel.includes(tk.id)} onChange={() => toggleSel(tk.id)} />
                        </td>
                        <td className={td}>{tk.subject || "(无标题)"}</td>
                        <td className={`${td} text-xs`}>
                          {tk.user?.username ?? "该会员号已注销"}
                          {tk.userId != null && <span className="ml-1 text-zinc-600">#{tk.userId}</span>}
                        </td>
                        <td className={`${td} text-xs`}>{tk.user?.nickname || "—"}</td>
                        <td className={td}>
                          {tk.ticketStatus && (
                            <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_BADGE[tk.ticketStatus] || ""}`}>
                              {STATUS_TEXT[tk.ticketStatus] || tk.ticketStatus}
                            </span>
                          )}
                          {tk.newMsgCount > 0 && (
                            <span className="ml-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-xs font-semibold text-white">
                              {tk.newMsgCount > 99 ? "99+" : tk.newMsgCount}
                            </span>
                          )}
                        </td>
                        <td className={`${td} text-xs`}>{fmt(tk.lastAt)}</td>
                        <td className={`${td} text-xs`}>{fmt(tk.createdAt)}</td>
                        <td className={`${td} text-xs`}>{tk.replyBy || "—"}</td>
                        <td className={td}>
                          <Link
                            href={`${ADMIN_BASE}/messages/${tk.id}`}
                            className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-emerald-400 hover:border-emerald-500"
                          >
                            查看回复
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {tickets != null && total > PAGE_SIZE && (
            <div className="mt-3 flex items-center justify-center gap-3 text-sm text-zinc-400">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => { setSel([]); loadTickets(status, page - 1); }}
                className="rounded-lg border border-zinc-700 px-3 py-1 hover:bg-zinc-800 disabled:opacity-40"
              >
                上一页
              </button>
              <span>
                {page} / {Math.ceil(total / PAGE_SIZE)}
              </span>
              <button
                type="button"
                disabled={page >= Math.ceil(total / PAGE_SIZE)}
                onClick={() => { setSel([]); loadTickets(status, page + 1); }}
                className="rounded-lg border border-zinc-700 px-3 py-1 hover:bg-zinc-800 disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── 消息群发 / 单发 ── */}
      {section === "broadcast" && (
        <div className="space-y-5">
          <div className="grid gap-5 lg:grid-cols-2">
            {/* 群发 */}
            <div className="rounded-xl border border-zinc-800 p-5">
              <h3 className="mb-3 text-sm font-semibold text-zinc-200">消息群发（通知）</h3>
              <input
                value={bcSubject}
                onChange={(e) => setBcSubject(e.target.value)}
                maxLength={200}
                placeholder="标题（可选）"
                className={`${inputCls} mb-2`}
              />
              <textarea
                value={bcBody}
                onChange={(e) => setBcBody(e.target.value)}
                rows={5}
                maxLength={5000}
                placeholder="通知内容…"
                className={`${inputCls} mb-2`}
              />
              <div className="mb-2">
                <select
                  value={bcTarget}
                  onChange={(e) => setBcTarget(e.target.value as typeof bcTarget)}
                  className={inputCls}
                >
                  <option value="all">全部用户</option>
                  <option value="users">指定用户 ID</option>
                  <option value="registered">按注册时间</option>
                  <option value="balance">按余额区间（有积分用户）</option>
                </select>
              </div>
              {bcTarget === "users" && (
                <input
                  value={bcUserIds}
                  onChange={(e) => setBcUserIds(e.target.value)}
                  placeholder="用户 ID 列表，逗号或空格分隔，如 1,2,3"
                  className={`${inputCls} mb-2`}
                />
              )}
              {bcTarget === "registered" && (
                <div className="mb-2 grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    value={bcRegFrom}
                    onChange={(e) => setBcRegFrom(e.target.value)}
                    placeholder="起始日期"
                    className={inputCls}
                  />
                  <input
                    type="date"
                    value={bcRegTo}
                    onChange={(e) => setBcRegTo(e.target.value)}
                    placeholder="截止日期"
                    className={inputCls}
                  />
                </div>
              )}
              {bcTarget === "balance" && (
                <div className="mb-2 grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    min={0}
                    value={bcBalMin}
                    onChange={(e) => setBcBalMin(e.target.value)}
                    placeholder="余额下限（积分）"
                    className={inputCls}
                  />
                  <input
                    type="number"
                    min={0}
                    value={bcBalMax}
                    onChange={(e) => setBcBalMax(e.target.value)}
                    placeholder="余额上限（积分）"
                    className={inputCls}
                  />
                </div>
              )}
              <button
                type="button"
                onClick={sendBroadcast}
                disabled={busy || !bcBody.trim()}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy ? "发送中…" : "发送群发通知"}
              </button>
              {bcResult && <p className="mt-2 text-xs text-emerald-400">{bcResult}</p>}
              <p className="mt-2 text-xs text-zinc-600">
                群发按批次（batchId）逐用户投递一条消息，用户在会员中心「消息·工单」查看。注册时间/余额区间人群均排除已封禁用户。
              </p>
            </div>

            {/* 单发 */}
            <div className="rounded-xl border border-zinc-800 p-5">
              <h3 className="mb-3 text-sm font-semibold text-zinc-200">单发通知</h3>
              <input
                value={nUserId}
                onChange={(e) => setNUserId(e.target.value)}
                placeholder="目标用户 ID"
                className={`${inputCls} mb-2`}
              />
              <input
                value={nSubject}
                onChange={(e) => setNSubject(e.target.value)}
                maxLength={200}
                placeholder="标题（可选）"
                className={`${inputCls} mb-2`}
              />
              <textarea
                value={nBody}
                onChange={(e) => setNBody(e.target.value)}
                rows={5}
                maxLength={5000}
                placeholder="通知内容…"
                className={`${inputCls} mb-2`}
              />
              <button
                type="button"
                onClick={sendNotice}
                disabled={busy || !nBody.trim() || !nUserId.trim()}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy ? "发送中…" : "发送通知"}
              </button>
              {nResult && <p className="mt-2 text-xs text-emerald-400">{nResult}</p>}
            </div>
          </div>

          {/* 历史批次 */}
          <div className="rounded-xl border border-zinc-800 p-5">
            <h3 className="mb-3 text-sm font-semibold text-zinc-200">历史批次</h3>
            {batches == null ? (
              <p className="text-sm text-zinc-500">加载中…</p>
            ) : batches.length === 0 ? (
              <p className="text-sm text-zinc-500">暂无群发批次</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-zinc-900/60">
                    <tr>
                      <th className={th}>主题</th>
                      <th className={th}>投递数</th>
                      <th className={th}>发送时间</th>
                      <th className={th}>批次号</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {batches.map((b) => (
                      <tr key={b.batchId} className="hover:bg-zinc-900/40">
                        <td className={`${td} max-w-[320px] truncate`}>
                          {b.subject || <span className="text-xs text-zinc-500">{b.preview || "(无标题)"}</span>}
                        </td>
                        <td className={td}>{b.count}</td>
                        <td className={`${td} text-xs`}>{fmt(b.sentAt)}</td>
                        <td className={`${td} text-xs text-zinc-600`}>{b.batchId.slice(0, 8)}…</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
