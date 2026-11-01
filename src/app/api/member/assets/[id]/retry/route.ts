import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { verifyApiKey } from "@/lib/apikey";
import { retryAssetTransfer } from "@/lib/assets";

export const dynamic = "force-dynamic";

// ─── P5 产物转存：重试拉取一次 ───
// POST /api/member/assets/[id]/retry
// 鉴权双通道：站内登录态 / 站外 Bearer sk- Key。
// 仅转存失败（status=deleted 且留存 sourceUrl）的资产可重试；
// 成功后清 sourceUrl，同一资产只允许重试拉取一次。
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let userId: number;
  const authHeader = (req.headers.get("authorization") || "").trim();
  if (authHeader) {
    const m = /^Bearer\s+(\S+)$/i.exec(authHeader);
    const r = m ? await verifyApiKey(m[1]) : null;
    if (!r || !r.ok) {
      return NextResponse.json({ error: "API Key 无效或已失效" }, { status: 401 });
    }
    userId = r.user.id;
  } else {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    userId = user.id;
  }

  const { id } = await params;
  let assetId: bigint;
  try {
    assetId = BigInt(id);
  } catch {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const r = await retryAssetTransfer(assetId, userId);
  if (!r.ok) return NextResponse.json({ error: r.error || "重试拉取失败" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
