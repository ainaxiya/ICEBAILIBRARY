import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// ─── 冰山实验场 M2：单个会话的读取 / 重命名 / 删除 ───
// 所有操作都先按 userId 校验归属，避免枚举他人会话 id。

async function ownedSession(userId: number, rawId: string) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.playgroundSession.findFirst({ where: { id, userId }, select: { id: true } });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await ctx.params;
  const sid = Number(id);
  if (!Number.isInteger(sid) || sid <= 0) {
    return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  }

  const session = await db.playgroundSession.findFirst({
    where: { id: sid, userId: user.id },
    select: { id: true, title: true, modelName: true, updatedAt: true },
  });
  if (!session) return NextResponse.json({ error: "会话不存在" }, { status: 404 });

  const messages = await db.playgroundMessage.findMany({
    where: { sessionId: sid },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, content: true, taskId: true },
  });

  // 媒体消息：把任务状态一并带回，刷新/重新登录后图片、视频与进度都能恢复
  const taskIds = messages.map((m) => m.taskId).filter((v): v is string => !!v);
  const tasks = taskIds.length
    ? await db.playgroundMediaTask.findMany({
        where: { taskId: { in: taskIds }, userId: user.id },
        select: {
          taskId: true,
          status: true,
          progress: true,
          stage: true,
          resultUrls: true,
          errorMessage: true,
          requestSize: true,
          latencyMs: true,
        },
      })
    : [];
  const byTaskId = new Map(tasks.map((t) => [t.taskId, t]));
  const payload = messages.map((m) => {
    const t = m.taskId ? byTaskId.get(m.taskId) : null;
    let urls: string[] = [];
    if (t?.resultUrls) {
      try {
        const parsed = JSON.parse(t.resultUrls);
        if (Array.isArray(parsed)) urls = parsed.filter((u): u is string => typeof u === "string");
      } catch {
        /* 忽略历史脏数据 */
      }
    }
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      taskId: m.taskId,
      media: t
        ? {
            status: t.status,
            progress: t.progress,
            stage: t.stage,
            urls,
            error: t.errorMessage,
            size: t.requestSize,
            latencyMs: t.latencyMs,
          }
        : null,
    };
  });

  return NextResponse.json({ session, messages: payload });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await ctx.params;
  const owned = await ownedSession(user.id, id);
  if (!owned) return NextResponse.json({ error: "会话不存在" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { title?: unknown } | null;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) return NextResponse.json({ error: "标题不能为空" }, { status: 400 });

  await db.playgroundSession.update({
    where: { id: owned.id },
    data: { title: title.slice(0, 60) },
  });

  return NextResponse.json({ ok: true, title: title.slice(0, 60) });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await ctx.params;
  const owned = await ownedSession(user.id, id);
  if (!owned) return NextResponse.json({ error: "会话不存在" }, { status: 404 });

  // 消息表外键为 ON DELETE CASCADE，删除会话即连带删除消息
  await db.playgroundSession.delete({ where: { id: owned.id } });

  return NextResponse.json({ ok: true });
}
