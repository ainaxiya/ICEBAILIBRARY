import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { sanitizeRich } from "@/lib/sanitize.server";
import { isHtmlContent, stripHtml } from "@/lib/rich";

export const dynamic = "force-dynamic";

// POST /api/member/messages/[id]/reply —— 回复工单（自己的会话才能回）
// id 为会话内任意消息 ID，回复统一挂到会话根消息（replyToId 串对话）
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { id } = await params;
  let msgId: bigint;
  try {
    msgId = BigInt(id);
  } catch {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const msg = await db.userMessage.findFirst({ where: { id: msgId, userId: user.id } });
  if (!msg) return NextResponse.json({ error: "会话不存在" }, { status: 404 });

  // 会话根消息
  const rootId = msg.replyToId ?? msg.id;
  const root = msg.replyToId ? await db.userMessage.findFirst({ where: { id: rootId, userId: user.id } }) : msg;
  if (!root) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  if (root.msgType !== "ticket") return NextResponse.json({ error: "该消息不支持回复" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const raw = typeof body?.body === "string" ? body.body.trim() : "";
  const content = isHtmlContent(raw) ? sanitizeRich(raw) : raw;
  if (!stripHtml(content)) return NextResponse.json({ error: "回复内容不能为空" }, { status: 400 });
  if (content.length > 20000) return NextResponse.json({ error: "内容过长（最多 20000 字符）" }, { status: 400 });

  const [created] = await db.$transaction([
    db.userMessage.create({
      data: {
        userId: user.id,
        direction: "user_to_admin",
        msgType: "ticket",
        subject: root.subject,
        body: content,
        replyToId: rootId,
      },
    }),
    // v0.92 #4：用户再次回复 → 已回复工单转「新的消息需处理」；新工单保持「新工单需处理」
    db.userMessage.update({
      where: { id: rootId },
      data: { ticketStatus: root.ticketStatus && root.ticketStatus !== "open" ? "pending" : "open" },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    message: {
      id: String(created.id),
      direction: created.direction,
      msgType: created.msgType,
      subject: created.subject,
      body: created.body,
      createdAt: created.createdAt,
    },
  });
}
