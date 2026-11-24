import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getBalance } from "@/lib/credits";

export const dynamic = "force-dynamic";

// GET /api/playground/balance —— 实验场上上传前/提交前的余额快照
// 上传素材前前端先核一次，避免积分不足时仍把首帧/参考素材落盘成孤儿文件。
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ balance: Number(await getBalance(user.id)) });
}
