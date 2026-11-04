import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { keyPrefixOf } from "@/lib/model-json";

export const dynamic = "force-dynamic";

const STATUS = ["active", "disabled"] as const;

// GET /api/admin/models/keys —— Key 列表（只回 keyPrefix，不回明文/密文）
export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const vendorId = Number(req.nextUrl.searchParams.get("vendorId") || 0);
  const status = req.nextUrl.searchParams.get("status") || undefined;

  const keys = await db.vendorApiKey.findMany({
    where: {
      ...(vendorId ? { vendorId } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { id: "asc" },
    include: { vendor: { select: { name: true } } },
  });

  return NextResponse.json({
    keys: keys.map((k) => ({
      id: k.id,
      vendorId: k.vendorId,
      vendorName: k.vendor.name,
      name: k.name,
      keyPrefix: k.keyPrefix,
      configured: true,
      status: k.status,
      remark: k.remark,
      lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
      createdAt: k.createdAt.toISOString(),
    })),
  });
}

const createSchema = z.object({
  vendorId: z.number().int().positive(),
  name: z.string().trim().min(1).max(50),
  apiKey: z.string().min(1).max(500),
  status: z.enum(STATUS).optional(),
  remark: z.string().max(500).optional(),
});

// POST /api/admin/models/keys —— 新建 Key（明文只进不出）
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

  const key = await db.vendorApiKey.create({
    data: {
      vendorId: data.vendorId,
      name: data.name,
      keyPrefix: keyPrefixOf(data.apiKey),
      keyCipher: encryptSecret(data.apiKey),
      status: data.status || "active",
      remark: data.remark || null,
    },
  });

  await logAdminAction({
    adminId: admin.id,
    action: "create",
    targetType: "vendor_api_key",
    targetId: key.id,
    detail: JSON.stringify({ vendor: vendor.name, name: key.name, keyPrefix: key.keyPrefix }),
    ip: await getClientIp(),
  });

  return NextResponse.json({
    ok: true,
    key: { id: key.id, name: key.name, keyPrefix: key.keyPrefix, configured: true },
  });
}
