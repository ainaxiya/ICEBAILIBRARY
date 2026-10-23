import { NextRequest, NextResponse } from "next/server";
import { requirePerm } from "@/lib/rbac";
import { testBucket } from "@/lib/s3";

export const dynamic = "force-dynamic";

// 测试未保存的桶配置（新建前表单直测）
export async function POST(req: NextRequest) {
  const { ok } = await requirePerm("storage:manage");
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  if (!body?.endpoint || !body?.bucket || !body?.accessKey || !body?.secretKey) {
    return NextResponse.json({ error: "端点/桶名/AK/SK 均为必填" }, { status: 400 });
  }

  const result = await testBucket({
    endpoint: String(body.endpoint),
    region: String(body.region || "us-east-1"),
    bucket: String(body.bucket),
    accessKey: String(body.accessKey),
    secretKey: String(body.secretKey),
    publicBaseUrl: null,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
