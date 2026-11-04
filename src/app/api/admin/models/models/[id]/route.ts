import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { latestPricing } from "@/lib/gateway/pricing";
import { pricingJson } from "@/lib/model-json";

export const dynamic = "force-dynamic";

const STATUS = ["online", "deprecated", "offline"] as const;
const ENDPOINT_TYPES = ["chat", "image", "video", "audio"] as const;

// GET /api/admin/models/models/[id] —— 详情：端点/定价历史
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

  const m = await db.aiModel.findUnique({
    where: { id: modelId },
    include: {
      vendor: { select: { id: true, name: true } },
      pricings: { orderBy: { effectiveAt: "desc" } },
      endpoints: { orderBy: { id: "asc" } },
    },
  });
  if (!m) return NextResponse.json({ error: "模型不存在" }, { status: 404 });

  const cur = latestPricing(m);
  return NextResponse.json({
    model: {
      id: m.id,
      vendorId: m.vendorId,
      vendorName: m.vendor.name,
      name: m.name,
      displayName: m.displayName,
      endpointType: m.endpointType,
      status: m.status,
      remark: m.remark,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    },
    currentPricing: cur ? pricingJson(cur) : null,
    pricings: m.pricings.map(pricingJson),
    endpoints: m.endpoints.map((e) => ({ id: e.id, path: e.path, enabled: e.enabled })),
  });
}

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  displayName: z.string().trim().min(1).max(100).optional(),
  endpointType: z.enum(ENDPOINT_TYPES).optional(),
  // 上下线：online | deprecated | offline
  status: z.enum(STATUS).optional(),
  remark: z.string().max(500).nullable().optional(),
});

// PUT /api/admin/models/models/[id] —— 更新/上下线
export async function PUT(
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

  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const exists = await db.aiModel.findUnique({ where: { id: modelId } });
  if (!exists) return NextResponse.json({ error: "模型不存在" }, { status: 404 });

  const data = parsed.data;
  if (data.name && data.name !== exists.name) {
    const dup = await db.aiModel.findFirst({
      where: { vendorId: exists.vendorId, name: data.name, NOT: { id: modelId } },
    });
    if (dup) return NextResponse.json({ error: "该厂商下模型名已存在" }, { status: 409 });
  }

  const model = await db.aiModel.update({
    where: { id: modelId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
      ...(data.endpointType !== undefined ? { endpointType: data.endpointType } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.remark !== undefined ? { remark: data.remark } : {}),
    },
  });

  await logAdminAction({
    adminId: admin.id,
    action: data.status && data.status !== exists.status ? "status_change" : "update",
    targetType: "ai_model",
    targetId: modelId,
    detail: JSON.stringify({ name: model.name, keys: Object.keys(data), from: exists.status, to: model.status }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, model: { id: model.id, name: model.name, status: model.status } });
}

// DELETE /api/admin/models/models/[id] —— 级联删除端点/定价
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const { id } = await params;
  const modelId = Number(id);
  if (!Number.isInteger(modelId)) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  const exists = await db.aiModel.findUnique({ where: { id: modelId } });
  if (!exists) return NextResponse.json({ error: "模型不存在" }, { status: 404 });

  await db.aiModel.delete({ where: { id: modelId } });

  await logAdminAction({
    adminId: admin.id,
    action: "delete",
    targetType: "ai_model",
    targetId: modelId,
    detail: JSON.stringify({ name: exists.name }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true });
}
