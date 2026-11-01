import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { cleanupExpiredAssets } from "@/lib/asset-cleanup";

export const dynamic = "force-dynamic";

// ─── P5 生成资产 30 天清理：后台手动触发 ───
// POST /api/admin/assets/cleanup（后台管理员）
// 定时任务本期不做（本地开发），将来接 cron 后此端点保留为手动兜底。
export async function POST() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const summary = await cleanupExpiredAssets();
  return NextResponse.json({ ok: true, ...summary });
}
