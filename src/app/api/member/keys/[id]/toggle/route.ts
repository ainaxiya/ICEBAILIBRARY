import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { setApiKeyDisabled } from "@/lib/apikey";

export const dynamic = "force-dynamic";

// ─── b2：Key 行内启停 ───
// POST /api/member/keys/[id]/toggle —— active ↔ disabled（已吊销不可恢复）
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { id } = await params;
  const keyId = parseInt(id, 10);
  if (!Number.isInteger(keyId) || keyId <= 0) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const key = await db.userApiKey.findFirst({
    where: { id: keyId, userId: user.id },
    select: { status: true },
  });
  if (!key) return NextResponse.json({ error: "Key 不存在" }, { status: 404 });
  if (key.status !== "active" && key.status !== "disabled") {
    return NextResponse.json({ error: "已吊销的 Key 不能启用" }, { status: 409 });
  }

  const next = key.status === "active" ? "disabled" : "active";
  const ok = await setApiKeyDisabled(keyId, user.id, next === "disabled");
  if (!ok) return NextResponse.json({ error: "状态已变化，请刷新后重试" }, { status: 409 });
  return NextResponse.json({ ok: true, status: next });
}
