import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

const putSchema = z.object({
  endpoints: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(200),
        enabled: z.boolean().optional(),
      })
    )
    .max(10),
});

// PUT /api/admin/models/models/[id]/endpoints —— 端点全量替换（按 path 增改、多余删除）
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

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const model = await db.aiModel.findUnique({ where: { id: modelId } });
  if (!model) return NextResponse.json({ error: "模型不存在" }, { status: 404 });

  // 去重 path
  const seen = new Set<string>();
  const endpoints = parsed.data.endpoints.filter((e) => {
    if (seen.has(e.path)) return false;
    seen.add(e.path);
    return true;
  });

  await db.$transaction(async (tx) => {
    const existing = await tx.modelEndpoint.findMany({ where: { modelId } });
    const keepPaths = new Set(endpoints.map((e) => e.path));
    await tx.modelEndpoint.deleteMany({
      where: { modelId, path: { notIn: [...keepPaths] } },
    });
    for (const e of endpoints) {
      const old = existing.find((x) => x.path === e.path);
      if (old) {
        await tx.modelEndpoint.update({
          where: { id: old.id },
          data: { enabled: e.enabled ?? old.enabled },
        });
      } else {
        await tx.modelEndpoint.create({
          data: { modelId, path: e.path, enabled: e.enabled ?? true },
        });
      }
    }
  });

  const rows = await db.modelEndpoint.findMany({ where: { modelId }, orderBy: { id: "asc" } });

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "model_endpoint",
    targetId: modelId,
    detail: JSON.stringify({ model: model.name, endpoints: rows.map((r) => r.path) }),
    ip: await getClientIp(),
  });

  return NextResponse.json({
    ok: true,
    endpoints: rows.map((e) => ({ id: e.id, path: e.path, enabled: e.enabled })),
  });
}
