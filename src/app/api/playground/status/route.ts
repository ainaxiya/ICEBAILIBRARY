import { NextResponse } from "next/server";
import { getPlaygroundMaintenance } from "@/lib/ops/maintenance";

export const dynamic = "force-dynamic";

// 实验场公开状态：前端据此展示维护提示并停止提交（提交接口另有服务端拦截）
export async function GET() {
  const m = await getPlaygroundMaintenance();
  return NextResponse.json(
    { maintenance: { enabled: m.enabled, message: m.message } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
