"use client";

import { useCallback, useEffect, useState } from "react";

// ─── P4 后台：消息·工单（工单队列 + 对话弹层 + 回复/关闭 + 群发/单发通知） ───

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
};

type Msg = {
  id: string;
  direction: string;
  msgType: string;
  subject: string | null;
  body: string;
  batchId: string | null;
  readAt: string | null;
  createdAt: string;
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
  replied: "bg-emerald-500/15 text-emerald-300",
  closed: "bg-zinc-700 text-zinc-400",
};
const STATUS_TEXT: Record<string, string> = {
  open: "待处理",
  replied: "已回复",
  closed: "已关闭",
};

function fmt(d: string | Date | null) {
  if (!d) return "—";
  const x = new Date(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

// P6 发票工单识别：subject 含「发票」关键词（不扩表）
const isInvoice = (subject: string | null) => !!subject && subject.includes("发票");

// P6 发票快捷回复模板（追加 admin_to_user 回复，不新增工单状态）
const INVOICE_TEMPLATES = {
  processing: "【发票处理中】您的开票申请已受理，我们正在处理中，开具完成后会在本工单回复您，请留意消息。",
  issued: "【已开票】您的发票已开具完成，请注意查收。如需修改抬头或重新开具，请在本工单继续留言。",
};

const PAGE_SIZE = 20;

export default function AdminMessages() {
  const [section, setSection] = useState<"tickets" | "broadcast">("tickets");

  // 工单队列
  const [status, setStatus] = useState<"open" | "replied" | "closed" | "all">("open");
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  // 对话弹层
  const [threadId, setThreadId] = useState<string | null>(null);
  const [thread, setThread] = useState<{ subject: string | null; ticketStatus: string | null; user: Ticket["user"] } | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [replyText, setReplyText] = useState("");
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

  const openThread = async (id: string) => {
    setThreadId(id);
    setError("");
    try {
      const r = await fetch(`/api/admin/messages?threadId=${encodeURIComponent(id)}`);
      const d = await r.json();
      if (r.ok) {
        setThread(d.thread);
        setMessages(d.messages || []);
      } else {
        setError(d.error || "加载失败");
      }
    } catch {
      setError("加载失败，请稍后重试");
    }
  };

  const closeThread = async () => {
    if (!threadId || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close", threadId }),
      });
      const d = await r.json();
      if (r.ok) {
        openThread(threadId);
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

  const sendReply = async (preset?: string) => {
    const content = (preset ?? replyText).trim();
    if (!threadId || !content || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/admin/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reply", threadId, body: content }),
      });
      const d = await r.json();
      if (r.ok) {
        setReplyText("");
        openThread(threadId);
        loadTickets(status, page);
      } else {
        setError(d.error || "回复失败");
      }
    } catch {
      setError("回复失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

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
                ["open", "待处理"],
                ["replied", "已回复"],
                ["closed", "已关闭"],
                ["all", "全部"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setStatus(k)}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  status === k ? "bg-zinc-800 text-emerald-300" : "text-zinc-500 hover:bg-zinc-800"
                }`}
              >
                {label}
              </button>
            ))}
            <span className="ml-auto text-xs text-zinc-500">共 {total} 条</span>
          </div>

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
                      <th className={th}>用户</th>
                      <th className={th}>标题</th>
                      <th className={th}>最新内容</th>
                      <th className={th}>状态</th>
                      <th className={th}>时间</th>
                      <th className={th}>操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {tickets.map((tk) => (
                      <tr key={tk.id} className="hover:bg-zinc-900/40">
                        <td className={`${td} text-xs`}>
                          {tk.user.nickname || tk.user.username}
                          <span className="ml-1 text-zinc-600">#{tk.userId}</span>
                        </td>
                        <td className={td}>
                          {isInvoice(tk.subject) && (
                            <span className="mr-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-300">发票</span>
                          )}
                          {tk.subject || "(无标题)"}
                        </td>
                        <td className={`${td} max-w-[240px] truncate text-xs text-zinc-500`}>{tk.lastBody}</td>
                        <td className={td}>
                          {tk.ticketStatus && (
                            <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_BADGE[tk.ticketStatus] || ""}`}>
                              {STATUS_TEXT[tk.ticketStatus] || tk.ticketStatus}
                            </span>
                          )}
                        </td>
                        <td className={`${td} text-xs`}>{fmt(tk.lastAt)}</td>
                        <td className={td}>
                          <button
                            type="button"
                            onClick={() => openThread(tk.id)}
                            className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-emerald-400 hover:border-emerald-500"
                          >
                            查看 / 回复
                          </button>
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
                onClick={() => loadTickets(status, page - 1)}
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
                onClick={() => loadTickets(status, page + 1)}
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

      {/* 对话详情弹层 */}
      {threadId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={() => setThreadId(null)}>
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-zinc-700 bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-zinc-800 px-5 py-3">
              <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">
                {thread?.subject || "(无标题)"}
              </h3>
              {thread && isInvoice(thread.subject) && (
                <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-300">发票</span>
              )}
              {thread?.user && (
                <span className="text-xs text-zinc-500">
                  用户：{thread.user.nickname || thread.user.username}（#{thread.user.id}）
                </span>
              )}
              {thread?.ticketStatus && (
                <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_BADGE[thread.ticketStatus] || ""}`}>
                  {STATUS_TEXT[thread.ticketStatus] || thread.ticketStatus}
                </span>
              )}
              <button
                type="button"
                onClick={() => setThreadId(null)}
                className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-zinc-800"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                    m.direction === "user_to_admin" ? "bg-zinc-800/80 text-zinc-200" : "ml-auto bg-emerald-500/15 text-zinc-200"
                  }`}
                >
                  <p className="mb-1 text-[10px] text-zinc-500">
                    {m.direction === "user_to_admin" ? "用户" : "管理员"} · {fmt(m.createdAt)}
                  </p>
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                </div>
              ))}
            </div>

            <div className="border-t border-zinc-800 p-4">
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                rows={2}
                maxLength={5000}
                placeholder="输入回复内容…"
                className={inputCls}
              />
              <div className="mt-2 flex items-center gap-2">
                {thread?.ticketStatus !== "closed" && (
                  <button
                    type="button"
                    onClick={closeThread}
                    disabled={busy}
                    className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-rose-500 hover:text-rose-300 disabled:opacity-50"
                  >
                    关闭工单
                  </button>
                )}
                {/* P6 发票快捷操作：追加模板回复（不新增工单状态） */}
                {thread && isInvoice(thread.subject) && (
                  <>
                    <button
                      type="button"
                      onClick={() => sendReply(INVOICE_TEMPLATES.processing)}
                      disabled={busy}
                      className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-sky-300 hover:border-sky-500 disabled:opacity-50"
                    >
                      标记发票处理中
                    </button>
                    <button
                      type="button"
                      onClick={() => sendReply(INVOICE_TEMPLATES.issued)}
                      disabled={busy}
                      className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-sky-300 hover:border-sky-500 disabled:opacity-50"
                    >
                      标记已开票
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => sendReply()}
                  disabled={busy || !replyText.trim()}
                  className="ml-auto rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {busy ? "发送中…" : "回复"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
