import { NextRequest, NextResponse } from "next/server";
import { requirePerm } from "@/lib/rbac";
import { backfillAssetMimeTypes } from "@/lib/assets";

export const dynamic = "force-dynamic";

// 存量资产 MIME 回填（管理端手动触发）：
// 只读对象字节嗅探、只更新 generated_asset.mimeType，不动对象、不改 assetType。
// 嗅探不出的记录保持 NULL。
export async function POST(req: NextRequest) {
  const { ok } = await requirePerm("storage:manage");
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const limit = Number(body?.limit) || 200;
  try {
    return NextResponse.json(await backfillAssetMimeTypes(limit));
  } catch (e) {
    return NextResponse.json({ error: `回填失败：${(e as Error).message}` }, { status: 500 });
  }
}
