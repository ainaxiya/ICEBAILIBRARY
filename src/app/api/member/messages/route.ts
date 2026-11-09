import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { isTicketType } from "@/lib/tickets";
import { sanitizeRich } from "@/lib/sanitize.server";
import { isHtmlContent, stripHtml } from "@/lib/rich";

export const dynamic = "force-dynamic";

// ─── P4 用户中心：消息·工单（用户侧） ───
// 会话 = 根消息（replyToId NULL）+ 回复链（replyToId 指向根消息）

function msgJson(m: {
  id: bigint;
  direction: string;
  msgType: string;
  subject: string | null;
  body: string;
  ticketStatus: string | null;
  batchId: string | null;
  readAt: Date | null;
  replyByNick?: string | null;
  createdAt: Date;
}) {
  return {
    id: String(m.id),
    direction: m.direction,
    msgType: m.msgType,
    subject: m.subject,
    body: m.body,
    ticketStatus: m.ticketStatus,
    batchId: m.batchId,
    readAt: m.readAt,
    // v0.92 #4：前台只显管理员昵称（不透出管理账号）
    replyByNick: m.replyByNick ?? null,
    createdAt: m.createdAt,
  };
}

// GET /api/member/messages —— 我的消息列表（工单会话 + 通知）
// GET /api/member/messages?threadId=xx —— 单个会话完整对话
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const threadIdRaw = req.nextUrl.searchParams.get("threadId");
  if (threadIdRaw) {
    let rootId: bigint;
    try {
      rootId = BigInt(threadIdRaw);
    } catch {
      return NextResponse.json({ error: "参数错误" }, { status: 400 });
    }
    const root = await db.userMessage.findFirst({
      where: { id: rootId, userId: user.id },
    });
    if (!root) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    const messages = await db.userMessage.findMany({
      where: { userId: user.id, OR: [{ id: rootId }, { replyToId: rootId }] },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({
      thread: { ...msgJson(root), replyCount: messages.length - 1 },
      messages: messages.map(msgJson),
    });
  }

  // 会话列表：用户发起的工单根消息
  const roots = await db.userMessage.findMany({
    where: { userId: user.id, replyToId: null, msgType: "ticket" },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      replies: {
        orderBy: { createdAt: "asc" },
        select: { id: true, direction: true, body: true, readAt: true, createdAt: true },
      },
    },
  });

  // 通知列表（管理员单发/群发，msgType=notice）
  const notices = await db.userMessage.findMany({
    where: { userId: user.id, replyToId: null, msgType: "notice" },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return NextResponse.json({
    threads: roots.map((r) => {
      const last = r.replies[r.replies.length - 1];
      return {
        ...msgJson(r),
        replyCount: r.replies.length,
        lastBody: last?.body ?? r.body,
        lastAt: last?.createdAt ?? r.createdAt,
        unread: r.replies.filter((x) => x.direction === "admin_to_user" && !x.readAt).length,
      };
    }),
    notices: notices.map((n) => ({ ...msgJson(n), unread: n.direction === "admin_to_user" && !n.readAt })),
  });
}

// POST /api/member/messages —— 新建工单（msgType=ticket, direction=user_to_admin）
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const body = await req.json().catch(() => null);

  // v0.92 #6：会员侧关闭工单
  if (body?.action === "close") {
    const threadId = typeof body?.threadId === "string" ? BigInt(body.threadId) : null;
    if (!threadId) return NextResponse.json({ error: "参数错误" }, { status: 400 });
    const root = await db.userMessage.findFirst({
      where: { id: threadId, userId: user.id, msgType: "ticket", replyToId: null },
    });
    if (!root) return NextResponse.json({ error: "工单不存在" }, { status: 404 });
    await db.userMessage.update({ where: { id: root.id }, data: { ticketStatus: "closed" } });
    return NextResponse.json({ ok: true });
  }

  // v0.92 #4：标题改为问题类型下拉必选
  const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
  if (!isTicketType(subject)) {
    return NextResponse.json({ error: "请选择问题类型" }, { status: 400 });
  }
  const raw = typeof body?.body === "string" ? body.body.trim() : "";
  const content = isHtmlContent(raw) ? sanitizeRich(raw) : raw;
  if (!stripHtml(content)) return NextResponse.json({ error: "工单内容不能为空" }, { status: 400 });
  if (content.length > 20000) return NextResponse.json({ error: "内容过长（最多 20000 字符）" }, { status: 400 });

  const created = await db.userMessage.create({
    data: {
      userId: user.id,
      direction: "user_to_admin",
      msgType: "ticket",
      subject,
      body: content,
      ticketStatus: "open",
    },
  });
  return NextResponse.json({ ok: true, thread: msgJson(created) });
}
