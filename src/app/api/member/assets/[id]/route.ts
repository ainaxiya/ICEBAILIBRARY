import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// DELETE /api/member/assets/[id] —— 软删（status=deleted，不物理删除）
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { id } = await params;
  let assetId: bigint;
  try {
    assetId = BigInt(id);
  } catch {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const asset = await db.generatedAsset.findFirst({
    where: { id: assetId, userId: user.id, status: "temp" },
    select: { id: true },
  });
  if (!asset) return NextResponse.json({ error: "资产不存在或已删除" }, { status: 404 });

  await db.generatedAsset.update({
    where: { id: asset.id },
    data: { status: "deleted" },
  });
  return NextResponse.json({ ok: true });
}
