import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { verifyApiKey } from "@/lib/apikey";
import { bucketToConfig, presignDownload } from "@/lib/s3";

export const dynamic = "force-dynamic";

// GET /api/member/assets/[id]/download —— 下载（签名 URL，私有读）
// 鉴权双通道：站内登录态 / 站外 Bearer sk- Key（产物 URL 随 /v1 生成响应返回给站外调用方）
export async function GET(
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

  const asset = await db.generatedAsset.findFirst({
    where: { id: assetId, userId, status: "temp" },
    include: { bucket: true },
  });
  if (!asset) return NextResponse.json({ error: "资产不存在或已删除" }, { status: 404 });
  if (asset.expireAt && asset.expireAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: "资产已过期，请重新生成" }, { status: 410 });
  }
  if (!asset.bucket) return NextResponse.json({ error: "资产未关联存储" }, { status: 404 });

  // 私有读 + 签名 URL（60 秒有效），不走 publicBaseUrl 直链防外链遍历
  const url = await presignDownload(bucketToConfig(asset.bucket), asset.storageKey);
  return NextResponse.json({ url });
}
