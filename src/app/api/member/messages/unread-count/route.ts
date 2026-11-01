import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/member/messages/unread-count —— 导航栏未读数（管理员发来的未读消息）
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ count: 0 });
  const count = await db.userMessage.count({
    where: { userId: user.id, direction: "admin_to_user", readAt: null },
  });
  return NextResponse.json({ count });
}
