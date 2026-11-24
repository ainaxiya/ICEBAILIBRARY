import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { setApiKeyQuota } from "@/lib/apikey";

export const dynamic = "force-dynamic";

// ─── b2 硬额度：后台查看会员 API Key 与设置额度 ───
// GET   /api/admin/users/[id]/keys —— 列表（前缀/名称/状态/已用/额度/调用次数）
// PATCH /api/admin/users/[id]/keys —— body { keyId, quotaCredits: number | null }

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { ok } = await requirePerm(PERMISSIONS.USER_WRITE);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const uid = parseInt(id, 10);
  if (!Number.isInteger(uid) || uid <= 0) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const keys = await db.userApiKey.findMany({
    where: { userId: uid },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      status: true,
      expiresAt: true,
      quotaCredits: true,
      usedCredits: true,
      allowedModels: true,
      createdAt: true,
    },
  });

  const groups = keys.length
    ? await db.usageRecord.groupBy({
        by: ["apiKeyId"],
        where: { userId: uid, channel: "apikey" },
        _count: { _all: true },
        _sum: { paidCredits: true },
      })
    : [];
  const usageMap = new Map(
    groups.filter((g) => g.apiKeyId != null).map((g) => [String(g.apiKeyId), g])
  );

  return NextResponse.json({
    keys: keys.map((k) => {
      const g = usageMap.get(String(k.id));
      const aggregated = Number(g?._sum.paidCredits ?? 0);
      return {
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        status: k.status,
        expiresAt: k.expiresAt,
        createdAt: k.createdAt,
        quotaCredits: k.quotaCredits,
        allowedModels: k.allowedModels,
        usedCredits: Math.max(Number(k.usedCredits), aggregated),
        calls: g?._count._all ?? 0,
      };
    }),
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { admin, ok } = await requirePerm(PERMISSIONS.USER_WRITE);
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const uid = parseInt(id, 10);
  if (!Number.isInteger(uid) || uid <= 0) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const raw = await req.json().catch(() => null);
  const keyId = Number(raw?.keyId);
  if (!Number.isInteger(keyId) || keyId <= 0) {
    return NextResponse.json({ error: "缺少有效的 keyId" }, { status: 400 });
  }

  let quotaCredits: number | null = null;
  if (raw?.quotaCredits !== null && raw?.quotaCredits !== "" && raw?.quotaCredits !== undefined) {
    const n = Number(raw.quotaCredits);
    if (!Number.isInteger(n) || n < 0) {
      return NextResponse.json({ error: "额度必须是不小于 0 的整数（0 = 不限额）" }, { status: 400 });
    }
    // 统一口径：0 与留空一样表示不限额，不再把 0 存成「0 额度」导致 Key 一律不可用
    quotaCredits = n > 0 ? n : null;
  }

  const key = await db.userApiKey.findFirst({
    where: { id: keyId, userId: uid },
    select: { id: true },
  });
  if (!key) return NextResponse.json({ error: "Key 不存在" }, { status: 404 });

  const done = await setApiKeyQuota(keyId, quotaCredits);
  if (!done) return NextResponse.json({ error: "设置失败" }, { status: 400 });

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "user",
    targetId: uid,
    detail: JSON.stringify({ apiKeyQuota: { keyId, quotaCredits } }),
    ip: (await getClientIp()) || undefined,
  });

  return NextResponse.json({ ok: true, keyId, quotaCredits });
}
