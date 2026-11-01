import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { pricingJson } from "@/lib/model-json";

export const dynamic = "force-dynamic";

// GET /api/admin/models/models/[id]/pricing —— 调价历史（按 effectiveAt 倒序）
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const { id } = await params;
  const modelId = Number(id);
  if (!Number.isInteger(modelId)) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  const pricings = await db.modelPricing.findMany({
    where: { modelId },
    orderBy: { effectiveAt: "desc" },
  });
  return NextResponse.json({ pricings: pricings.map(pricingJson) });
}

const postSchema = z.object({
  meterBase: z.number().int().min(1).max(1_000_000_000).optional(),
  unit: z.enum(["token", "image", "video_second", "request"]).optional(),
  inputPrice: z.number().min(0).max(1_000_000),
  outputPrice: z.number().min(0).max(1_000_000),
  currency: z.string().trim().max(10).optional(),
  fxRateE8: z.number().int().min(1).max(1_000_000_000_000).optional(),
  multiplierBps: z.number().int().min(1).max(100_000).optional(),
  effectiveAt: z.string().datetime().optional(),
});

// POST /api/admin/models/models/[id]/pricing —— 调价：新增一行历史（不改旧行）
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const { id } = await params;
  const modelId = Number(id);
  if (!Number.isInteger(modelId)) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const data = parsed.data;

  const model = await db.aiModel.findUnique({ where: { id: modelId } });
  if (!model) return NextResponse.json({ error: "模型不存在" }, { status: 404 });

  // 无历史行时沿用默认计量基数；有历史行默认继承上一行的计量口径
  const prev = await db.modelPricing.findFirst({
    where: { modelId },
    orderBy: { effectiveAt: "desc" },
  });

  const row = await db.modelPricing.create({
    data: {
      modelId,
      meterBase: data.meterBase ?? prev?.meterBase ?? 1_000_000,
      unit: data.unit ?? prev?.unit ?? "token",
      inputPrice: data.inputPrice,
      outputPrice: data.outputPrice,
      currency: data.currency || prev?.currency || "CNY",
      fxRateE8: BigInt(data.fxRateE8 ?? prev?.fxRateE8 ?? 100_000_000),
      multiplierBps: data.multiplierBps ?? prev?.multiplierBps ?? 150,
      effectiveAt: data.effectiveAt ? new Date(data.effectiveAt) : new Date(),
    },
  });

  await logAdminAction({
    adminId: admin.id,
    action: "create",
    targetType: "model_pricing",
    targetId: row.id,
    detail: JSON.stringify({
      model: model.name,
      inputPrice: data.inputPrice,
      outputPrice: data.outputPrice,
      multiplierBps: row.multiplierBps,
      effectiveAt: row.effectiveAt.toISOString(),
    }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, pricing: pricingJson(row) });
}
