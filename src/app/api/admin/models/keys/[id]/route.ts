import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { keyPrefixOf } from "@/lib/model-json";

export const dynamic = "force-dynamic";

const STATUS = ["active", "disabled"] as const;

const updateSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  // 轮换 Key：传新明文则重新加密；不传则保持原密文
  apiKey: z.string().min(1).max(500).optional(),
  status: z.enum(STATUS).optional(),
  remark: z.string().max(500).nullable().optional(),
});

// PUT /api/admin/models/keys/[id] —— 更新/轮换 Key（响应不回显明文/密文）
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const { id } = await params;
  const keyId = Number(id);
  if (!Number.isInteger(keyId)) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const exists = await db.vendorApiKey.findUnique({ where: { id: keyId } });
  if (!exists) return NextResponse.json({ error: "Key 不存在" }, { status: 404 });

  const data = parsed.data;
  const key = await db.vendorApiKey.update({
    where: { id: keyId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.apiKey !== undefined
        ? { keyPrefix: keyPrefixOf(data.apiKey), keyCipher: encryptSecret(data.apiKey) }
        : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.remark !== undefined ? { remark: data.remark } : {}),
    },
  });

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "vendor_api_key",
    targetId: keyId,
    detail: JSON.stringify({
      name: key.name,
      keyPrefix: key.keyPrefix,
      rotated: data.apiKey !== undefined,
    }),
    ip: await getClientIp(),
  });

  return NextResponse.json({
    ok: true,
    key: { id: key.id, name: key.name, keyPrefix: key.keyPrefix, configured: true, status: key.status },
  });
}

// DELETE /api/admin/models/keys/[id] —— 删除 Key
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const { id } = await params;
  const keyId = Number(id);
  if (!Number.isInteger(keyId)) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  const exists = await db.vendorApiKey.findUnique({ where: { id: keyId } });
  if (!exists) return NextResponse.json({ error: "Key 不存在" }, { status: 404 });

  await db.vendorApiKey.delete({ where: { id: keyId } });

  await logAdminAction({
    adminId: admin.id,
    action: "delete",
    targetType: "vendor_api_key",
    targetId: keyId,
    detail: JSON.stringify({ name: exists.name, keyPrefix: exists.keyPrefix }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true });
}
