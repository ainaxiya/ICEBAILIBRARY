import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { encryptSecret } from "@/lib/crypto";

export const dynamic = "force-dynamic";

// 更新（secretKey 留空 = 不修改）
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { admin, ok } = await requirePerm("storage:manage");
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const row = await db.storageBucket.findUnique({ where: { id: Number(id) } });
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const name = (body?.name || "").trim();
  const endpoint = (body?.endpoint || "").trim();
  const bucket = (body?.bucket || "").trim();
  const accessKey = (body?.accessKey || "").trim();
  if (!name || !endpoint || !bucket || !accessKey) {
    return NextResponse.json({ error: "名称/端点/桶名/AK 均为必填" }, { status: 400 });
  }

  const isDefault = !!body?.isDefault;
  await db.$transaction(async (tx) => {
    if (isDefault) await tx.storageBucket.updateMany({ where: { id: { not: row.id } }, data: { isDefault: false } });
    await tx.storageBucket.update({
      where: { id: row.id },
      data: {
        name,
        type: body?.type === "s3" ? "s3" : "minio",
        endpoint,
        region: (body?.region || "").trim() || null,
        bucket,
        accessKey,
        ...(body?.secretKey ? { secretKey: encryptSecret(String(body.secretKey).trim()) } : {}),
        publicBaseUrl: (body?.publicBaseUrl || "").trim() || null,
        isDefault,
        enabled: body?.enabled !== false,
      },
    });
  });

  await logAdminAction({
    adminId: admin.id, action: "update", targetType: "storage_bucket", targetId: row.id,
    detail: `更新存储桶「${name}」`, ip: await getClientIp(),
  });
  return NextResponse.json({ ok: true });
}

// 删除（有下载记录引用时拒绝）
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { admin, ok } = await requirePerm("storage:manage");
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const row = await db.storageBucket.findUnique({ where: { id: Number(id) } });
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const used = await db.softwareDownload.count({ where: { bucketId: row.id } });
  if (used > 0) {
    return NextResponse.json({ error: `该存储桶已被 ${used} 条软件下载记录引用，无法删除` }, { status: 409 });
  }

  await db.storageBucket.delete({ where: { id: row.id } });
  await logAdminAction({
    adminId: admin.id, action: "delete", targetType: "storage_bucket", targetId: row.id,
    detail: `删除存储桶「${row.name}」(${row.bucket})`, ip: await getClientIp(),
  });
  return NextResponse.json({ ok: true });
}
