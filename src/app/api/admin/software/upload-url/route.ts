import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { requirePerm } from "@/lib/rbac";
import { bucketToConfig, presignUpload } from "@/lib/s3";

export const dynamic = "force-dynamic";

// 生成对象存储预签名直传 URL（浏览器 PUT 直传，不经过应用服务器中转）
// 注意：桶需配置 CORS 允许本站来源的 PUT，否则浏览器直传会被拦截
export async function POST(req: NextRequest) {
  const { ok } = await requirePerm("software:manage");
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const bucketId = Number(body?.bucketId);
  const filename = String(body?.filename || "").trim();
  if (!bucketId || !filename) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }
  // 预签名把 ContentType 打进签名，浏览器必须原样回传同一值
  const contentType = String(body?.contentType || "application/octet-stream");

  const bucket = await db.storageBucket.findUnique({ where: { id: bucketId } });
  if (!bucket || !bucket.enabled) {
    return NextResponse.json({ error: "存储桶不存在或已停用" }, { status: 404 });
  }

  const ext = (filename.split(".").pop() || "").toLowerCase().replace(/[^\w]/g, "");
  const ym = new Date().toISOString().slice(0, 7).replace("-", "");
  const safeBase = filename.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-").slice(0, 40) || "file";
  const objectKey = `soft/${ym}/${safeBase}-${crypto.randomBytes(4).toString("hex")}${ext ? "." + ext : ""}`;

  const url = await presignUpload(bucketToConfig(bucket), objectKey, contentType);
  return NextResponse.json({ url, objectKey });
}
