import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// POST /api/member/messages/[id]/read —— 标已读（readAt）
// id 为会话内任意消息 ID；会话内所有管理员发来的未读消息一并标记
export async function POST(
  _req: NextRequest,
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
  if (!msg) return NextResponse.json({ error: "消息不存在" }, { status: 404 });
  const rootId = msg.replyToId ?? msg.id;

  const res = await db.userMessage.updateMany({
    where: {
      userId: user.id,
      direction: "admin_to_user",
      readAt: null,
      OR: [{ id: rootId }, { replyToId: rootId }],
    },
    data: { readAt: new Date() },
  });
  return NextResponse.json({ ok: true, marked: res.count });
}
