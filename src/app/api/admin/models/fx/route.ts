import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// GET /api/admin/models/fx —— 汇率表（币种 → RMB）
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const rows = await db.fxRate.findMany({ orderBy: { currency: "asc" } });
  return NextResponse.json({
    rates: rows.map((r) => ({ currency: r.currency, rate: Number(r.rateE8) / 1e8 })),
  });
}

const putSchema = z.object({
  rates: z
    .array(
      z.object({
        currency: z.string().trim().regex(/^[A-Za-z]{3}$/, "币种为 3 位字母（如 USD）"),
        rate: z.number().min(0.01).max(1000),
      })
    )
    .min(1)
    .max(50),
});

// PUT /api/admin/models/fx —— 批量 upsert 汇率（整表保存）；同步该币种全部定价的汇率快照
export async function PUT(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }

  // 币种去重（后者覆盖前者），CNY 固定为 1 不入表
  const map = new Map<string, number>();
  for (const r of parsed.data.rates) {
    const cur = r.currency.toUpperCase();
    if (cur === "CNY") continue;
    map.set(cur, r.rate);
  }

  for (const [currency, rate] of map) {
    const rateE8 = BigInt(Math.round(rate * 1e8));
    await db.fxRate.upsert({
      where: { currency },
      create: { currency, rateE8 },
      update: { rateE8 },
    });
    // 同步该币种全部定价的汇率快照（成本价不变，成本积分/会员价/计费即时按新汇率）
    await db.modelPricing.updateMany({ where: { currency }, data: { fxRateE8: rateE8 } });
  }

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "fx_rate",
    targetId: 0,
    detail: JSON.stringify(Object.fromEntries(map)),
    ip: await getClientIp(),
  });

  const rows = await db.fxRate.findMany({ orderBy: { currency: "asc" } });
  return NextResponse.json({
    ok: true,
    rates: rows.map((r) => ({ currency: r.currency, rate: Number(r.rateE8) / 1e8 })),
  });
}
