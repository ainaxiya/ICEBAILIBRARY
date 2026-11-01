import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { revokeApiKey } from "@/lib/apikey";

export const dynamic = "force-dynamic";

// ─── P5 站外双通道：吊销 API Key ───
// POST /api/member/keys/[id]/revoke（仅限本人 Key，幂等）

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

  const ok = await revokeApiKey(keyId, user.id);
  if (!ok) return NextResponse.json({ error: "Key 不存在或已吊销" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
