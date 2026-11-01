import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { latestPricing, totalCostMilli, displayCredits } from "@/lib/gateway/pricing";
import { pricingJson } from "@/lib/model-json";

export const dynamic = "force-dynamic";

const STATUS = ["online", "deprecated", "offline"] as const;
const ENDPOINT_TYPES = ["chat", "image", "video", "audio"] as const;

// GET /api/admin/models/models —— 模型列表（含当前生效定价与成本预览），过滤 status/vendorId
export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const vendorId = Number(sp.get("vendorId") || 0);
  const status = sp.get("status") || undefined;

  const models = await db.aiModel.findMany({
    where: {
      ...(vendorId ? { vendorId } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { id: "asc" },
    include: {
      vendor: { select: { id: true, name: true } },
      pricings: { orderBy: { effectiveAt: "desc" } },
      endpoints: { orderBy: { id: "asc" } },
      _count: { select: { bindings: true } },
    },
  });

  return NextResponse.json({
    models: models.map((m) => {
      const cur = latestPricing(m);
      return {
        id: m.id,
        vendorId: m.vendorId,
        vendorName: m.vendor.name,
        name: m.name,
        displayName: m.displayName,
        endpointType: m.endpointType,
        status: m.status,
        remark: m.remark,
        bindingCount: m._count.bindings,
        endpoints: m.endpoints.map((e) => ({ id: e.id, path: e.path, enabled: e.enabled })),
        currentPricing: cur ? pricingJson(cur) : null,
        // 成本换算预览：100 万输入 + 50 万输出 token 的内部成本与用户标价（演示口径）
        pricePreview: cur
          ? {
              costMilli: totalCostMilli(cur, 1_000_000, 500_000),
              displayCredits: displayCredits(totalCostMilli(cur, 1_000_000, 500_000), cur.multiplierBps),
            }
          : null,
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
      };
    }),
  });
}

const pricingSchema = z.object({
  meterBase: z.number().int().min(1).max(1_000_000_000).optional(),
  unit: z.enum(["token", "image", "video_second", "request"]).optional(),
  inputPrice: z.number().min(0).max(1_000_000),
  outputPrice: z.number().min(0).max(1_000_000),
  currency: z.string().trim().max(10).optional(),
  fxRateE8: z.number().int().min(1).max(1_000_000_000_000).optional(),
  multiplierBps: z.number().int().min(1).max(100_000).optional(),
  effectiveAt: z.string().datetime().optional(),
});

const createSchema = z.object({
  vendorId: z.number().int().positive(),
  name: z.string().trim().min(1).max(100),
  displayName: z.string().trim().min(1).max(100),
  endpointType: z.enum(ENDPOINT_TYPES).optional(),
  status: z.enum(STATUS).optional(),
  remark: z.string().max(500).optional(),
  pricing: pricingSchema.optional(),
  endpoints: z.array(z.object({ path: z.string().trim().min(1).max(200), enabled: z.boolean().optional() })).max(10).optional(),
});

// POST /api/admin/models/models —— 新建模型（可带初始定价/端点）
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const data = parsed.data;

  const vendor = await db.aiVendor.findUnique({ where: { id: data.vendorId } });
  if (!vendor) return NextResponse.json({ error: "厂商不存在" }, { status: 404 });

  const dup = await db.aiModel.findFirst({
    where: { vendorId: data.vendorId, name: data.name },
  });
  if (dup) return NextResponse.json({ error: "该厂商下模型名已存在" }, { status: 409 });

  const model = await db.aiModel.create({
    data: {
      vendorId: data.vendorId,
      name: data.name,
      displayName: data.displayName,
      endpointType: data.endpointType || "chat",
      status: data.status || "online",
      remark: data.remark || null,
    },
  });

  if (data.pricing) {
    await db.modelPricing.create({
      data: {
        modelId: model.id,
        meterBase: data.pricing.meterBase ?? 1_000_000,
        unit: data.pricing.unit ?? "token",
        inputPrice: data.pricing.inputPrice,
        outputPrice: data.pricing.outputPrice,
        currency: data.pricing.currency || "CNY",
        fxRateE8: BigInt(data.pricing.fxRateE8 ?? 100_000_000),
        multiplierBps: data.pricing.multiplierBps ?? 150,
        effectiveAt: data.pricing.effectiveAt ? new Date(data.pricing.effectiveAt) : new Date(),
      },
    });
  }

  if (data.endpoints?.length) {
    await db.modelEndpoint.createMany({
      data: data.endpoints.map((e) => ({
        modelId: model.id,
        path: e.path,
        enabled: e.enabled ?? true,
      })),
    });
  }

  await logAdminAction({
    adminId: admin.id,
    action: "create",
    targetType: "ai_model",
    targetId: model.id,
    detail: JSON.stringify({ vendor: vendor.name, name: model.name }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, model: { id: model.id, name: model.name, displayName: model.displayName } });
}
