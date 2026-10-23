import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm } from "@/lib/rbac";
import { healOrphanJob } from "@/lib/crawl-worker";

export const dynamic = "force-dynamic";

// GET /api/admin/collect/jobs/:id  采集任务进度
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { ok } = await requirePerm(PERMISSIONS.CRAWL_MANAGE);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const jobId = Number(id);
  if (!jobId) return NextResponse.json({ error: "bad id" }, { status: 400 });

  // 库里有 running 但本进程没有执行句柄（服务重启/进程退出）→ 自动标记中断，避免永久卡住
  await healOrphanJob(jobId);

  const job = await db.crawlJob.findUnique({ where: { id: jobId } });
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({
    id: job.id,
    status: job.status,
    total: job.total,
    done: job.done,
    succeeded: job.succeeded,
    failed: job.failed,
    lastError: job.lastError,
    message: job.message,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  });
}
