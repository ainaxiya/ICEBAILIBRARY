"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ─── P4 用户中心：消息·工单（会话列表 + 对话详情 + 回复 + 新建工单） ───

type Thread = {
  id: string;
  subject: string | null;
  body: string;
  ticketStatus: string | null;
  createdAt: string;
  lastBody: string;
  lastAt: string;
  replyCount: number;
  unread: number;
};

type Notice = {
  id: string;
  subject: string | null;
  body: string;
  batchId: string | null;
  readAt: string | null;
  createdAt: string;
  unread: boolean;
};

type Msg = {
  id: string;
  direction: string;
  msgType: string;
  subject: string | null;
  body: string;
  createdAt: string;
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

function fmt(d: string | Date) {
  const x = new Date(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

export default function MessageCenter({ newTicketSignal = 0 }: { newTicketSignal?: number }) {
  const [listLoading, setListLoading] = useState(true);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [section, setSection] = useState<"tickets" | "notices">("tickets");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // 新建工单弹层
  const [showModal, setShowModal] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const [newBody, setNewBody] = useState("");
  // 初始 0：外部信号从 0 递增时触发；挂载即带信号（如发票条「提工单」）也要打开
  const lastSignal = useRef(0);

  const loadList = useCallback(async () => {
    try {
      const r = await fetch("/api/member/messages");
      const d = await r.json();
      if (r.ok) {
        setThreads(d.threads || []);
        setNotices(d.notices || []);
      }
    } catch {
      // 静默，下次操作重试
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // 发票「提工单」快捷入口等外部触发
  useEffect(() => {
    if (newTicketSignal !== lastSignal.current) {
      lastSignal.current = newTicketSignal;
      setShowModal(true);
    }
  }, [newTicketSignal]);

  const openThread = async (id: string) => {
    setSelectedId(id);
    setError("");
    try {
      const r = await fetch(`/api/member/messages?threadId=${encodeURIComponent(id)}`);
      const d = await r.json();
      if (r.ok) {
        setMessages(d.messages || []);
        // 打开即标已读
        await fetch(`/api/member/messages/${encodeURIComponent(id)}/read`, { method: "POST" }).catch(() => {});
        loadList();
      } else {
        setError(d.error || "加载失败");
      }
    } catch {
      setError("加载失败，请稍后重试");
    }
  };

  const reply = async () => {
    const content = replyText.trim();
    if (!content || !selectedId || sending) return;
    setSending(true);
    setError("");
    try {
      const r = await fetch(`/api/member/messages/${encodeURIComponent(selectedId)}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: content }),
      });
      const d = await r.json();
      if (r.ok) {
        setReplyText("");
        openThread(selectedId);
      } else {
        setError(d.error || "回复失败");
      }
    } catch {
      setError("回复失败，请稍后重试");
    } finally {
      setSending(false);
    }
  };

  const createTicket = async () => {
    const content = newBody.trim();
    if (!content || sending) return;
    setSending(true);
    setError("");
    try {
      const r = await fetch("/api/member/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: newSubject.trim(), body: content }),
      });
      const d = await r.json();
      if (r.ok) {
        setShowModal(false);
        setNewSubject("");
        setNewBody("");
        await loadList();
        openThread(d.thread.id);
      } else {
        setError(d.error || "提交失败");
      }
    } catch {
      setError("提交失败，请稍后重试");
    } finally {
      setSending(false);
    }
  };

  const selected = threads.find((t) => t.id === selectedId) || null;
  const totalUnread =
    threads.reduce((s, t) => s + t.unread, 0) + notices.filter((n) => n.unread).length;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setSection("tickets")}
          className={`rounded-lg px-3 py-1.5 text-sm ${section === "tickets" ? "bg-emerald-500/15 text-emerald-300" : "text-zinc-400 hover:bg-zinc-800"}`}
        >
          工单会话
        </button>
        <button
          type="button"
          onClick={() => setSection("notices")}
          className={`rounded-lg px-3 py-1.5 text-sm ${section === "notices" ? "bg-emerald-500/15 text-emerald-300" : "text-zinc-400 hover:bg-zinc-800"}`}
        >
          通知{notices.filter((n) => n.unread).length > 0 && ` (${notices.filter((n) => n.unread).length})`}
        </button>
        <span className="ml-auto text-xs text-zinc-500">{totalUnread > 0 ? `${totalUnread} 条未读` : "全部已读"}</span>
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400"
        >
          + 新建工单
        </button>
      </div>

      {error && <p className="mb-2 text-xs text-rose-400">{error}</p>}

      {section === "tickets" ? (
        <div className="grid gap-3 lg:grid-cols-[280px_1fr]">
          {/* 会话列表 */}
          <div className="overflow-hidden rounded-xl border border-zinc-800">
            {listLoading ? (
              <div className="p-4 text-center text-sm text-zinc-500">加载中…</div>
            ) : threads.length === 0 ? (
              <div className="p-4 text-center text-sm text-zinc-500">还没有工单会话</div>
            ) : (
              <ul className="max-h-[420px] divide-y divide-zinc-800/70 overflow-y-auto">
                {threads.map((th) => (
                  <li key={th.id}>
                    <button
                      type="button"
                      onClick={() => openThread(th.id)}
                      className={`block w-full px-3 py-2.5 text-left transition hover:bg-zinc-900/60 ${selectedId === th.id ? "bg-zinc-900/80" : ""}`}
                    >
                      <div className="flex items-center gap-2">
                        {th.unread > 0 && <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />}
                        <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{th.subject || "(无标题)"}</span>
                        {th.ticketStatus && (
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${STATUS_BADGE[th.ticketStatus] || ""}`}>
                            {STATUS_TEXT[th.ticketStatus] || th.ticketStatus}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate text-xs text-zinc-500">{th.lastBody}</p>
                      <p className="mt-1 text-[10px] text-zinc-600">{fmt(th.lastAt)}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 对话详情 */}
          <div className="flex min-h-[320px] flex-col rounded-xl border border-zinc-800">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center p-6 text-sm text-zinc-500">
                选择左侧会话查看对话，或点击「新建工单」
              </div>
            ) : (
              <>
                <div className="border-b border-zinc-800 px-4 py-3">
                  <h3 className="text-sm font-semibold text-zinc-100">{selected.subject || "(无标题)"}</h3>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    创建于 {fmt(selected.createdAt)}
                    {selected.ticketStatus && (
                      <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${STATUS_BADGE[selected.ticketStatus] || ""}`}>
                        {STATUS_TEXT[selected.ticketStatus] || selected.ticketStatus}
                      </span>
                    )}
                  </p>
                </div>
                <div className="max-h-[300px] flex-1 space-y-3 overflow-y-auto px-4 py-3">
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                        m.direction === "user_to_admin"
                          ? "ml-auto bg-emerald-500/15 text-zinc-200"
                          : "bg-zinc-800/80 text-zinc-200"
                      }`}
                    >
                      <p className="mb-1 text-[10px] text-zinc-500">
                        {m.direction === "user_to_admin" ? "我" : "管理员"} · {fmt(m.createdAt)}
                      </p>
                      <p className="whitespace-pre-wrap break-words">{m.body}</p>
                    </div>
                  ))}
                </div>
                {selected.ticketStatus !== "closed" ? (
                  <div className="border-t border-zinc-800 p-3">
                    <textarea
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      rows={2}
                      maxLength={5000}
                      placeholder="输入回复内容…"
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none"
                    />
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={reply}
                        disabled={sending || !replyText.trim()}
                        className="rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
                      >
                        {sending ? "发送中…" : "发送回复"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
                    该工单已关闭。如有新问题请
                    <button type="button" onClick={() => setShowModal(true)} className="mx-1 text-emerald-400 hover:underline">
                      新建工单
                    </button>
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        /* 通知列表 */
        <div className="overflow-hidden rounded-xl border border-zinc-800">
          {notices.length === 0 ? (
            <div className="p-6 text-center text-sm text-zinc-500">暂无通知</div>
          ) : (
            <ul className="divide-y divide-zinc-800/70">
              {notices.map((n) => (
                <li key={n.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {n.unread && <span className="h-2 w-2 rounded-full bg-emerald-400" />}
                    <span className="text-sm font-medium text-zinc-200">{n.subject || "(无标题)"}</span>
                    <span className="ml-auto text-[10px] text-zinc-600">{fmt(n.createdAt)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-400">{n.body}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 新建工单弹层 */}
      {showModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={() => setShowModal(false)}>
          <div
            className="w-full max-w-lg rounded-2xl border border-zinc-700 bg-zinc-900 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-base font-semibold text-zinc-100">新建工单</h3>
            <input
              value={newSubject}
              onChange={(e) => setNewSubject(e.target.value)}
              maxLength={200}
              placeholder="标题（可选）"
              className="mb-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none"
            />
            <textarea
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              rows={5}
              maxLength={5000}
              placeholder="请描述你的问题或需求…"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="rounded-lg border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                取消
              </button>
              <button
                type="button"
                onClick={createTicket}
                disabled={sending || !newBody.trim()}
                className="rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                {sending ? "提交中…" : "提交工单"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
