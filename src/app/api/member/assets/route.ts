import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// ─── P4 用户中心：我的资产（生成物，P5 生成链路写入，本期列表页） ───
// GET /api/member/assets —— 我的资产列表（temp 状态，按创建时间倒序）

const TYPE_LABEL: Record<string, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  file: "文件",
};

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const assets = await db.generatedAsset.findMany({
    where: { userId: user.id, status: "temp" },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const now = Date.now();
  return NextResponse.json({
    assets: assets.map((a) => {
      const msLeft = a.expireAt ? a.expireAt.getTime() - now : null;
      return {
        id: String(a.id),
        assetType: a.assetType,
        typeLabel: TYPE_LABEL[a.assetType] || a.assetType,
        storageKey: a.storageKey,
        fileName: a.storageKey.split("/").pop() || a.storageKey,
        sizeBytes: Number(a.sizeBytes),
        createdAt: a.createdAt,
        expireAt: a.expireAt,
        daysLeft: msLeft == null ? null : Math.floor(msLeft / 86400000),
        // 剩 <7 天标警示
        expiringSoon: msLeft != null && msLeft > 0 && msLeft < 7 * 86400000,
        expired: msLeft != null && msLeft <= 0,
        // 私有读：不给 publicBaseUrl 直链，统一走 /download 签名 URL
        directUrl: null,
      };
    }),
  });
}
