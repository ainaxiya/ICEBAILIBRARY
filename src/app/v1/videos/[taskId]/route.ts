import { NextRequest, NextResponse } from "next/server";
import { authenticateV1 } from "@/lib/gateway/auth";
import { apiError, gatewayError } from "@/lib/gateway/errors";
import { db } from "@/lib/db";
import { failStaleVideoTask } from "@/lib/gateway/video-task";

export const dynamic = "force-dynamic";

// ─── GET /v1/videos/{task_id} —— P6 #19 任务状态查询（轮询） ───
// 属主校验（本人任务才能查）；processing 超时惰性判 failed，
// 并同一处调用 billing.refund 退款（幂等），保证接口文案「费用已原路退回」与账务一致。

const SITE_BASE = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/+$/, "");

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  // ── 1. 鉴权 ──
  const auth = await authenticateV1(req);
  if (!auth.ok) {
    return apiError(auth.status, auth.message, "authentication_error", auth.code);
  }

  // ── 2. 查任务（存在 + 属主） ──
  const { taskId } = await params;
  const task = await db.videoTask.findUnique({ where: { taskId } });
  if (!task || task.userId !== auth.user.id) {
    return gatewayError("task_not_found", { message: "Task not found" });
  }

  // ── 3. 惰性超时：processing 卡死（服务重启）→ failed + 原路退款 ──
  // 原子条件更新（并发轮询只有一个能成功），退款与状态收口在同一函数内完成。
  let status = task.status;
  let errorMessage = task.errorMessage;
  if (status === "processing") {
    const failed = await failStaleVideoTask({
      taskId,
      userId: task.userId,
      requestId: task.requestId,
    });
    if (failed) {
      status = "failed";
      errorMessage = "任务执行超时（服务重启中断），费用已原路退回";
    }
  }

  // ── 4. 响应（succeeded 附产物地址：优先转存资产签名 URL，兜底原始 URL） ──
  const body: Record<string, unknown> = {
    task_id: task.taskId,
    status,
    progress: status === "succeeded" ? 100 : task.progress,
    model: task.modelSnapshot,
    created_at: task.createdAt.toISOString(),
    updated_at: task.updatedAt.toISOString(),
  };
  if (status === "succeeded") {
    let videoUrl: string | null = null;
    if (task.assetId != null) {
      videoUrl = `${SITE_BASE}/api/member/assets/${task.assetId}/download`;
    } else if (task.resultUrls) {
      try {
        videoUrl = (JSON.parse(task.resultUrls) as string[])[0] ?? null;
      } catch {
        videoUrl = null;
      }
    }
    body.video = { url: videoUrl, asset_id: task.assetId != null ? String(task.assetId) : null };
  }
  if (status === "failed") {
    body.error = errorMessage || "generation_failed";
  }
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
