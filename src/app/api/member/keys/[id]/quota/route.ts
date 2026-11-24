import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { setApiKeyQuota } from "@/lib/apikey";

export const dynamic = "force-dynamic";

// ─── b2 硬额度：Key 额度设置（会员本人） ───
// POST /api/member/keys/[id]/quota —— body { quotaCredits: number | null }
// quotaCredits = null 表示不限额；设置时会把历史用量并入已用计数。
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { id } = await params;
  const keyId = parseInt(id, 10);
  if (!Number.isInteger(keyId) || keyId <= 0) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const raw = await req.json().catch(() => null);
  if (raw == null || !Object.prototype.hasOwnProperty.call(raw, "quotaCredits")) {
    return NextResponse.json({ error: "缺少 quotaCredits 字段" }, { status: 400 });
  }

  let quotaCredits: number | null = null;
  if (raw.quotaCredits !== null && raw.quotaCredits !== "") {
    const n = Number(raw.quotaCredits);
    if (!Number.isInteger(n) || n < 0) {
      return NextResponse.json({ error: "额度必须是不小于 0 的整数" }, { status: 400 });
    }
    quotaCredits = n;
  }

  const ok = await setApiKeyQuota(keyId, quotaCredits, user.id);
  if (!ok) return NextResponse.json({ error: "Key 不存在" }, { status: 404 });
  return NextResponse.json({ ok: true, quotaCredits });
}
