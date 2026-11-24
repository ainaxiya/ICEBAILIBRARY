import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { createApiKey, normalizeAllowedModels } from "@/lib/apikey";

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
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      status: true,
      expiresAt: true,
      lastUsedAt: true,
      createdAt: true,
      quotaCredits: true,
      usedCredits: true,
      allowedModels: true,
    },
  });
  // b2：列表信息密度 —— 每把 Key 的已用积分与累计请求（按 apiKeyId 聚合）
  const groups = keys.length
    ? await db.usageRecord.groupBy({
        by: ["apiKeyId"],
        where: { userId: user.id, channel: "apikey" },
        _count: { _all: true },
        _sum: { paidCredits: true },
      })
    : [];
  const usageMap = new Map(
    groups
      .filter((g) => g.apiKeyId != null)
      .map((g) => [String(g.apiKeyId), g])
  );
  return NextResponse.json({
    keys: keys.map((k) => {
      const g = usageMap.get(String(k.id));
      // 已用口径：原子计数器（含预占）与历史流水聚合取大值，避免任一口径缺失导致低估
      const aggregated = Number(g?._sum.paidCredits ?? 0);
      const used = Math.max(Number(k.usedCredits), aggregated);
      return {
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        status: k.status,
        expiresAt: k.expiresAt,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt,
        // quotaCredits = null 表示不限额
        quotaCredits: k.quotaCredits,
        usedCredits: used,
        allowedModels: k.allowedModels,
        calls: g?._count._all ?? 0,
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const raw = await req.json().catch(() => ({}));
  // 自定义名称（可空，≤50 字符）
  let name: string | null = null;
  if (raw?.name != null && String(raw.name).trim()) {
    name = String(raw.name).trim().slice(0, 50);
  }
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

  // 额度上限（积分；null / 缺省 = 不限额）
  let quotaCredits: number | null = null;
  if (raw?.quotaCredits != null && raw.quotaCredits !== "") {
    const n = Number(raw.quotaCredits);
    if (!Number.isInteger(n) || n < 0) {
      return NextResponse.json({ error: "额度必须是不小于 0 的整数" }, { status: 400 });
    }
    quotaCredits = n;
  }

  // b1：模型白名单（数组或逗号/换行分隔字符串；空 = 不限制）
  let allowedModels: string[] = [];
  if (Array.isArray(raw?.allowedModels)) {
    allowedModels = normalizeAllowedModels(raw.allowedModels.map((m: unknown) => String(m)));
  } else if (typeof raw?.allowedModels === "string") {
    allowedModels = normalizeAllowedModels(raw.allowedModels.split(/[\n,，]+/));
  }

  const created = await createApiKey(user.id, expiresAt, name, quotaCredits, allowedModels);
  return NextResponse.json({
    id: created.id,
    name: created.name,
    keyPrefix: created.keyPrefix,
    // 明文仅此一次返回，创建后无法再查看
    key: created.plaintext,
    expiresAt: created.expiresAt,
    quotaCredits: created.quotaCredits,
    allowedModels: created.allowedModels,
  });
}
