import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { toTaskView } from "@/lib/playground/media-task-runner";

export const dynamic = "force-dynamic";

// ─── GET /api/playground/tasks/[taskId] —— 单个任务状态（前端轮询 / 刷新恢复） ───
// 只返回本人任务；游客任务（userId=0）凭不可猜的任务号轮询，其余不属于当前用户一律 404。
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ taskId: string }> }
) {
  const user = await getCurrentUser();
  const { taskId } = await ctx.params;
  const task = await db.playgroundMediaTask.findFirst({
    where: { taskId, userId: user ? user.id : 0 },
  });
  if (!task) {
    return NextResponse.json({ error: "任务不存在", code: "task_not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, task: toTaskView(task) });
}
