import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// GET /api/admin/models/bindings —— Key-模型绑定列表（过滤 modelId/apiKeyId）
export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const modelId = Number(sp.get("modelId") || 0);
  const apiKeyId = Number(sp.get("apiKeyId") || 0);

  const bindings = await db.keyModelBinding.findMany({
    where: {
      ...(modelId ? { modelId } : {}),
      ...(apiKeyId ? { apiKeyId } : {}),
    },
    orderBy: [{ modelId: "asc" }, { priority: "asc" }, { id: "asc" }],
    include: {
      apiKey: { select: { id: true, name: true, keyPrefix: true, status: true, vendor: { select: { name: true } } } },
      model: { select: { id: true, name: true, displayName: true, status: true } },
    },
  });

  return NextResponse.json({
    bindings: bindings.map((b) => ({
      id: b.id,
      apiKeyId: b.apiKeyId,
      keyName: b.apiKey.name,
      keyPrefix: b.apiKey.keyPrefix,
      keyStatus: b.apiKey.status,
      vendorName: b.apiKey.vendor.name,
      modelId: b.modelId,
      modelName: b.model.name,
      modelDisplayName: b.model.displayName,
      modelStatus: b.model.status,
      priority: b.priority,
      weight: b.weight,
      enabled: b.enabled,
      createdAt: b.createdAt.toISOString(),
    })),
  });
}

const createSchema = z.object({
  apiKeyId: z.number().int().positive(),
  modelId: z.number().int().positive(),
  priority: z.number().int().min(0).max(9999).optional(),
  weight: z.number().int().min(0).max(9999).optional(),
  enabled: z.boolean().optional(),
});

// POST /api/admin/models/bindings —— 新建绑定（同 Key+模型唯一）
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

  const key = await db.vendorApiKey.findUnique({ where: { id: data.apiKeyId } });
  if (!key) return NextResponse.json({ error: "Key 不存在" }, { status: 404 });
  const model = await db.aiModel.findUnique({ where: { id: data.modelId } });
  if (!model) return NextResponse.json({ error: "模型不存在" }, { status: 404 });

  const dup = await db.keyModelBinding.findUnique({
    where: { apiKeyId_modelId: { apiKeyId: data.apiKeyId, modelId: data.modelId } },
  });
  if (dup) return NextResponse.json({ error: "该 Key 与模型已绑定" }, { status: 409 });

  const binding = await db.keyModelBinding.create({
    data: {
      apiKeyId: data.apiKeyId,
      modelId: data.modelId,
      priority: data.priority ?? 0,
      weight: data.weight ?? 1,
      enabled: data.enabled ?? true,
    },
  });

  await logAdminAction({
    adminId: admin.id,
    action: "create",
    targetType: "key_model_binding",
    targetId: binding.id,
    detail: JSON.stringify({ key: key.name, model: model.name, priority: binding.priority, weight: binding.weight }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, binding: { id: binding.id } });
}

const updateSchema = z.object({
  id: z.number().int().positive(),
  priority: z.number().int().min(0).max(9999).optional(),
  weight: z.number().int().min(0).max(9999).optional(),
  enabled: z.boolean().optional(),
});

// PUT /api/admin/models/bindings —— 更新 priority/weight/enabled
export async function PUT(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { id, ...data } = parsed.data;
  const exists = await db.keyModelBinding.findUnique({ where: { id } });
  if (!exists) return NextResponse.json({ error: "绑定不存在" }, { status: 404 });

  const binding = await db.keyModelBinding.update({
    where: { id },
    data: {
      ...(data.priority !== undefined ? { priority: data.priority } : {}),
      ...(data.weight !== undefined ? { weight: data.weight } : {}),
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
    },
  });

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "key_model_binding",
    targetId: id,
    detail: JSON.stringify({ keys: Object.keys(data) }),
    ip: await getClientIp(),
  });

  return NextResponse.json({
    ok: true,
    binding: { id: binding.id, priority: binding.priority, weight: binding.weight, enabled: binding.enabled },
  });
}

// DELETE /api/admin/models/bindings?id= —— 删除绑定
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const id = Number(req.nextUrl.searchParams.get("id") || 0);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  const exists = await db.keyModelBinding.findUnique({ where: { id } });
  if (!exists) return NextResponse.json({ error: "绑定不存在" }, { status: 404 });

  await db.keyModelBinding.delete({ where: { id } });

  await logAdminAction({
    adminId: admin.id,
    action: "delete",
    targetType: "key_model_binding",
    targetId: id,
    detail: JSON.stringify({ apiKeyId: exists.apiKeyId, modelId: exists.modelId }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true });
}
