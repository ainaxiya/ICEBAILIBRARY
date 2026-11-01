import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// ─── P6 注册赠送开关（SiteSetting key="credits_config"） ───
// 默认关闭（trialEnabled=false）：注册接口的 trial 钩子读取此配置发放赠送积分。
// 支付代扣签约落地后一键开。

const schema = z.object({
  // 注册赠送开关：默认关闭
  trialEnabled: z.boolean(),
  // 每个新用户赠送积分（整数，0 = 不发放）
  trialCredits: z.coerce.number().int().min(0).max(10_000_000),
});

// GET /api/admin/settings/credits
export async function GET() {
  const { ok } = await requirePerm(PERMISSIONS.SETTING_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const row = await db.siteSetting.findUnique({ where: { key: "credits_config" } });
  const def = { trialEnabled: false, trialCredits: 0 };
  if (!row) return NextResponse.json(def);
  try {
    const p = JSON.parse(row.value) as Partial<typeof def>;
    return NextResponse.json({
      trialEnabled: Boolean(p.trialEnabled ?? def.trialEnabled),
      trialCredits: Number(p.trialCredits ?? def.trialCredits) || 0,
    });
  } catch {
    return NextResponse.json(def);
  }
}

// PUT /api/admin/settings/credits
export async function PUT(req: NextRequest) {
  const { user: admin, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!admin || !ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const value = {
    trialEnabled: parsed.data.trialEnabled && parsed.data.trialCredits > 0,
    trialCredits: parsed.data.trialCredits,
  };
  await db.siteSetting.upsert({
    where: { key: "credits_config" },
    update: { value: JSON.stringify(value) },
    create: { key: "credits_config", value: JSON.stringify(value) },
  });
  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "setting",
    detail: JSON.stringify({ section: "credits_config", ...value }),
    ip: await getClientIp(),
  });
  return NextResponse.json({ ok: true, value });
}
