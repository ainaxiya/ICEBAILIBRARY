import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePerm } from "@/lib/rbac";
import { bucketToConfig, testBucket } from "@/lib/s3";
import { decryptSecret } from "@/lib/crypto";

export const dynamic = "force-dynamic";

// 测试连接：支持两种入参
// 1) body 为空 → 测已保存的桶（用库内 AK/SK）
// 2) body 带 endpoint/bucket/accessKey/secretKey → 测表单未保存配置（secretKey 可空=用库内现有）
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { ok } = await requirePerm("storage:manage");
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  try {
    const { id } = await params;
    const row = await db.storageBucket.findUnique({ where: { id: Number(id) } });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    let cfg;
    if (body && body.endpoint) {
      let secret: string;
      if (body.secretKey) {
        secret = String(body.secretKey);
      } else {
        try {
          secret = decryptSecret(row.secretKey);
        } catch {
          return NextResponse.json(
            { ok: false, error: "存储桶密钥无法解密（历史密钥已变更）：请重新填写并保存该桶的 SecretKey 后再测试" },
            { status: 500 }
          );
        }
      }
      cfg = {
        endpoint: String(body.endpoint),
        region: (body.region || row.region || "us-east-1") as string,
        bucket: String(body.bucket || row.bucket),
        accessKey: String(body.accessKey || row.accessKey),
        secretKey: secret,
        publicBaseUrl: null,
      };
    } else {
      try {
        cfg = bucketToConfig(row);
      } catch {
        return NextResponse.json(
          { ok: false, error: "存储桶密钥无法解密（历史密钥已变更）：请到存储桶设置重新填写并保存该桶的 SecretKey 后再测试" },
          { status: 500 }
        );
      }
    }

    const result = await testBucket(cfg);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `测试连接失败：${(e as Error).message}` }, { status: 500 });
  }
}
