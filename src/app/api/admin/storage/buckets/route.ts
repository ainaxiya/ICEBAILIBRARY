import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { encryptSecret } from "@/lib/crypto";

export const dynamic = "force-dynamic";

// 列表（永不返回 secretKey 明文，仅 hasSecret 标记）
export async function GET() {
  const { ok } = await requirePerm("storage:manage");
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const rows = await db.storageBucket.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true, name: true, type: true, endpoint: true, region: true, bucket: true,
      accessKey: true, secretKey: true, publicBaseUrl: true, isDefault: true, enabled: true,
      createdAt: true, _count: { select: { downloads: true } },
    },
  });
  return NextResponse.json(
    rows.map(({ secretKey, _count, ...r }) => ({
      ...r,
      hasSecret: !!secretKey,
      downloadCount: _count.downloads,
    }))
  );
}

// 新建
export async function POST(req: NextRequest) {
  const { admin, ok } = await requirePerm("storage:manage");
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const name = (body?.name || "").trim();
  const endpoint = (body?.endpoint || "").trim();
  const bucket = (body?.bucket || "").trim();
  const accessKey = (body?.accessKey || "").trim();
  const secretKey = (body?.secretKey || "").trim();
  if (!name || !endpoint || !bucket || !accessKey || !secretKey) {
    return NextResponse.json({ error: "名称/端点/桶名/AK/SK 均为必填" }, { status: 400 });
  }

  const isDefault = !!body?.isDefault;
  const created = await db.$transaction(async (tx) => {
    if (isDefault) await tx.storageBucket.updateMany({ data: { isDefault: false } });
    return tx.storageBucket.create({
      data: {
        name,
        type: body?.type === "s3" ? "s3" : "minio",
        endpoint,
        region: (body?.region || "").trim() || null,
        bucket,
        accessKey,
        secretKey: encryptSecret(secretKey),
        publicBaseUrl: (body?.publicBaseUrl || "").trim() || null,
        isDefault,
        enabled: body?.enabled !== false,
      },
    });
  });

  await logAdminAction({
    adminId: admin.id, action: "create", targetType: "storage_bucket", targetId: created.id,
    detail: `新建存储桶「${name}」(${bucket})`, ip: await getClientIp(),
  });
  return NextResponse.json({ id: created.id });
}
