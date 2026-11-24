import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { purgeExpiredSessions } from "@/lib/playground/retention";

export const dynamic = "force-dynamic";

// ─── 冰山实验场 M2：会话列表 ───
// 只读当前登录用户自己的会话，按最近更新倒序；不返回消息内容，避免列表接口过重。

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  // 保留期开关默认关闭；开启后每次拉列表时顺带清理过期会话
  await purgeExpiredSessions(user.id).catch(() => 0);

  const sessions = await db.playgroundSession.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, modelName: true, updatedAt: true },
  });

  return NextResponse.json({ sessions });
}
