import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { isJobActive, requestCancelCrawlJob } from "@/lib/crawl-worker";

export const dynamic = "force-dynamic";

// POST /api/admin/collect/jobs/:id/cancel  手动中断采集任务
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { admin, ok } = await requirePerm(PERMISSIONS.CRAWL_MANAGE);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const jobId = Number(id);
  if (!jobId) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const job = await db.crawlJob.findUnique({ where: { id: jobId } });
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (job.status !== "running") {
    return NextResponse.json({ error: "任务已结束，无需中断" }, { status: 400 });
  }

  // 置中断标记：若任务仍在本进程运行，循环会在当前条目结束后停止
  requestCancelCrawlJob(jobId);

  // 无论是否还有执行句柄，都立即把状态落为已结束，避免界面永久卡在「进行中」
  await db.crawlJob.update({
    where: { id: jobId },
    data: {
      status: "done",
      finishedAt: new Date(),
      message: isJobActive(jobId)
        ? "已手动中断：当前条目处理完后停止后续采集"
        : "已手动中断（任务已不在运行，已强制结束）",
    },
  });

  await logAdminAction({
    adminId: admin.id,
    action: "collect_cancel",
    targetType: "crawl_job",
    targetId: jobId,
    detail: `中断采集任务 #${jobId}（已完成 ${job.done}/${job.total}）`,
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, jobId, done: job.done, total: job.total });
}
