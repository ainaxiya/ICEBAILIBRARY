import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { createApiKey } from "@/lib/apikey";

export const dynamic = "force-dynamic";

// ─── P5 站外双通道：会员 API Key 管理 ───
// GET  /api/member/keys —— 列表（只回前缀/状态/时间，不回明文）
// POST /api/member/keys —— 创建（可选过期时间），明文一次性返回

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const keys = await db.userApiKey.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, keyPrefix: true, status: true, expiresAt: true, lastUsedAt: true, createdAt: true },
  });
  return NextResponse.json({
    keys: keys.map((k) => ({
      id: k.id,
      keyPrefix: k.keyPrefix,
      status: k.status,
      expiresAt: k.expiresAt,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const raw = await req.json().catch(() => ({}));
  let expiresAt: Date | null = null;
  if (raw?.expiresAt) {
    const d = new Date(String(raw.expiresAt));
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "过期时间格式不正确" }, { status: 400 });
    }
    if (d.getTime() <= Date.now()) {
      return NextResponse.json({ error: "过期时间必须晚于当前时间" }, { status: 400 });
    }
    expiresAt = d;
  }

  const created = await createApiKey(user.id, expiresAt);
  return NextResponse.json({
    id: created.id,
    keyPrefix: created.keyPrefix,
    // 明文仅此一次返回，创建后无法再查看
    key: created.plaintext,
    expiresAt: created.expiresAt,
  });
}
