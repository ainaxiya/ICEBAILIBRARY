"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import RichEditor from "@/components/RichEditor";
import { isHtmlContent } from "@/lib/rich";
import { ADMIN_BASE } from "@/lib/admin-path";

// ─── v0.92 #4 工单客服式详情页：左栏会员信息（2 列竖排）+ 右栏消息流 + 富文本回复 ───

type Member = {
  id: number;
  username: string;
  nickname: string | null;
  status: string;
  allowPublish: boolean;
  commentBanned: boolean;
  balanceCredits: number;
  apiKeyCount: number;
  createdAt: string;
  registerIp: string | null;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
};

type Msg = {
  id: string;
  direction: string;
  msgType: string;
  subject: string | null;
  body: string;
  replyBy: string | null;
  replyByNick: string | null;
  adminReadAt: string | null;
  createdAt: string;
};

type ThreadHead = {
  id: string;
  subject: string | null;
  ticketStatus: string | null;
  createdAt: string;
  user: { id: number; username: string; nickname: string | null };
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

// 发票快捷回复模板
const INVOICE_TEMPLATES = {
  processing: "【发票处理中】您的开票申请已受理，我们正在处理中，开具完成后会在本工单回复您，请留意消息。",
  issued: "【已开票】您的发票已开具完成，请注意查收。如需修改抬头或重新开具，请在本工单继续留言。",
};

function fmt(d: string | Date | null) {
  if (!d) return "—";
  const x = new Date(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

function MsgBody({ body }: { body: string }) {
  if (isHtmlContent(body)) {
    return <div className="rich-content text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: body }} />;
  }
  return <p className="whitespace-pre-wrap break-words text-sm">{body}</p>;
}

// 会员信息条目（左栏 2 列竖排）
function InfoItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
      <p className="text-[10px] text-zinc-500">{label}</p>
      <p className="mt-0.5 break-all text-xs text-zinc-200">{value}</p>
    </div>
  );
}

export default function TicketDetail({ threadId }: { threadId: string }) {
  const [thread, setThread] = useState<ThreadHead | null>(null);
  const [member, setMember] = useState<Member | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [replyHtml, setReplyHtml] = useState("");
  const [closeAfter, setCloseAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/messages?threadId=${encodeURIComponent(threadId)}`);
      const d = await r.json();
      if (r.ok) {
        setThread(d.thread);
        setMember(d.member);
        setMessages(d.messages || []);
      } else {
        setError(d.error || "加载失败");
      }
    } catch {
      setError("加载失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    load();
  }, [load]);

  const sendReply = async (preset?: string) => {
    const content = (preset ?? replyHtml).trim();
    if (!content || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/admin/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reply", threadId, body: content, closeAfter: preset ? false : closeAfter }),
      });
      const d = await r.json();
      if (r.ok) {
        setReplyHtml("");
        load();
      } else {
        setError(d.error || "回复失败");
      }
    } catch {
      setError("回复失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const closeThread = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/admin/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close", threadId }),
      });
      const d = await r.json();
      if (r.ok) load();
      else setError(d.error || "操作失败");
    } catch {
      setError("操作失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="p-8 text-center text-sm text-zinc-500">加载中…</div>;
  if (!thread) return <div className="p-8 text-center text-sm text-zinc-500">{error || "工单不存在"}</div>;

  // 新会员消息红标数字：打开时未读（adminReadAt 为空）的会员消息按序编号
  const newNum = new Map<string, number>();
  let n = 0;
  for (const m of messages) {
    if (m.direction === "user_to_admin" && !m.adminReadAt) newNum.set(m.id, ++n);
  }

  return (
    <div>
      {/* 顶栏 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link
          href={`${ADMIN_BASE}/messages`}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          ← 返回工单列表
        </Link>
        <span className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300">{thread.subject || "(无标题)"}</span>
        {thread.ticketStatus && (
          <span className={`rounded px-2 py-1 text-xs ${STATUS_BADGE[thread.ticketStatus] || ""}`}>
            {STATUS_TEXT[thread.ticketStatus] || thread.ticketStatus}
          </span>
        )}
        <span className="text-xs text-zinc-500">创建于 {fmt(thread.createdAt)}</span>
      </div>

      {error && <p className="mb-3 text-sm text-rose-400">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        {/* ── 左栏：会员信息（2 列竖排） ── */}
        <aside className="space-y-2 self-start rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
          <h3 className="mb-1 text-xs font-semibold text-zinc-400">会员信息</h3>
          {member ? (
            <div className="grid grid-cols-2 gap-2">
              <InfoItem label="账号" value={member.username} />
              <InfoItem label="昵称" value={member.nickname || "—"} />
              <InfoItem
                label="账户状态"
                value={
                  member.status === "active" ? (
                    <span className="text-emerald-400">正常</span>
                  ) : (
                    <span className="text-rose-400">已封禁</span>
                  )
                }
              />
              <InfoItem
                label="发布权限"
                value={member.allowPublish ? <span className="text-emerald-400">允许</span> : <span className="text-rose-400">禁止</span>}
              />
              <InfoItem
                label="评论权限"
                value={member.commentBanned ? <span className="text-rose-400">已禁言</span> : <span className="text-emerald-400">正常</span>}
              />
              <InfoItem label="当前积分" value={<span className="text-amber-300">{member.balanceCredits} 积分</span>} />
              <InfoItem label="APIKey 数量" value={`${member.apiKeyCount} 个`} />
              <InfoItem label="注册时间" value={fmt(member.createdAt)} />
              <InfoItem label="注册IP" value={member.registerIp || "—"} />
              <InfoItem label="登录时间" value={fmt(member.lastLoginAt)} />
              <InfoItem label="登录IP" value={member.lastLoginIp || "—"} />
            </div>
          ) : (
            <p className="text-xs text-zinc-500">会员不存在</p>
          )}
        </aside>

        {/* ── 右栏：消息流 + 回复 ── */}
        <section className="flex flex-col rounded-xl border border-zinc-800">
          <div className="flex-1 space-y-3 p-4">
            {messages.map((m) => {
              const badge = newNum.get(m.id);
              return (
                <div
                  key={m.id}
                  className={`max-w-[82%] rounded-xl border px-3 py-2 ${
                    m.direction === "user_to_admin"
                      ? "border-zinc-700/60 bg-zinc-800/70"
                      : "ml-auto border-emerald-500/20 bg-emerald-500/10"
                  }`}
                >
                  <p className="mb-1 flex items-center gap-1.5 text-[10px] text-zinc-500">
                    {m.direction === "user_to_admin" ? (
                      <>
                        <span>{thread.user.nickname || thread.user.username}（会员）</span>
                        {badge && (
                          <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 font-semibold text-white">
                            {badge}
                          </span>
                        )}
                      </>
                    ) : (
                      <span>回复人：{m.replyBy ? `${m.replyBy}（${m.replyByNick || "管理员"}）` : "管理员"}</span>
                    )}
                    <span className="text-zinc-600">{fmt(m.createdAt)}</span>
                  </p>
                  <MsgBody body={m.body} />
                </div>
              );
            })}
          </div>

          {/* 回复区 */}
          {thread.ticketStatus !== "closed" ? (
            <div className="border-t border-zinc-800 p-4">
              <RichEditor
                value={replyHtml}
                onChange={setReplyHtml}
                placeholder="输入回复内容…"
                minHeight={140}
                maxImageMB={5}
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    checked={closeAfter}
                    onChange={(e) => setCloseAfter(e.target.checked)}
                    className="accent-emerald-500"
                  />
                  回复后关闭此工单
                </label>
                {thread.subject?.includes("发票") && (
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
                  onClick={closeThread}
                  disabled={busy}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-rose-500 hover:text-rose-300 disabled:opacity-50"
                >
                  关闭工单
                </button>
                <button
                  type="button"
                  onClick={() => sendReply()}
                  disabled={busy || !replyHtml.trim()}
                  className="ml-auto rounded-lg bg-emerald-600 px-5 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {busy ? "发送中…" : "回复"}
                </button>
              </div>
            </div>
          ) : (
            <p className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">该工单已关闭，如需继续处理可让会员追加消息或新建工单。</p>
          )}
        </section>
      </div>
    </div>
  );
}
