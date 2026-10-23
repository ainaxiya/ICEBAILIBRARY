import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { requirePerm } from "@/lib/rbac";
import { bucketToConfig, makeS3 } from "@/lib/s3";
import { PutObjectCommand } from "@aws-sdk/client-s3";

export const dynamic = "force-dynamic";

// 软件安装包 → 对象存储中转上传（浏览器 POST multipart 到本站，服务端 SDK 直传桶）
// 与预签名直传的区别：不依赖桶的 CORS 配置，浏览器只需能访问本站即可
const ALLOWED_EXT = new Set([
  "zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz",
  "dmg", "pkg", "exe", "msi", "apk", "ipa", "deb", "rpm", "appimage",
  "iso", "img", "txt", "pdf", "md", "json",
]);
const MAX_MB = 100;

export async function POST(req: NextRequest) {
  const { ok } = await requirePerm("software:manage");
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const bucketId = Number(form?.get("bucketId"));
  if (!(file instanceof File) || !bucketId) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }
  if (file.size > MAX_MB * 1024 * 1024) {
    return NextResponse.json({ error: `文件超过 ${MAX_MB}MB 上限` }, { status: 413 });
  }

  const rawName = file.name || "file";
  const ext = (rawName.split(".").pop() || "").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json({ error: `不支持的文件类型 .${ext}` }, { status: 400 });
  }

  const bucket = await db.storageBucket.findUnique({ where: { id: bucketId } });
  if (!bucket || !bucket.enabled) {
    return NextResponse.json({ error: "存储桶不存在或已停用" }, { status: 404 });
  }

  const ym = new Date().toISOString().slice(0, 7).replace("-", "");
  const safeBase = rawName.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-").slice(0, 40) || "file";
  const objectKey = `soft/${ym}/${safeBase}-${crypto.randomBytes(4).toString("hex")}.${ext}`;

  try {
    const cfg = bucketToConfig(bucket);
    const s3 = makeS3(cfg);
    await s3.send(new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: objectKey,
      Body: Buffer.from(await file.arrayBuffer()),
      ContentType: file.type || "application/octet-stream",
    }));
    return NextResponse.json({ objectKey, size: file.size });
  } catch (e) {
    return NextResponse.json({ error: `上传到桶失败：${(e as Error).message}` }, { status: 502 });
  }
}
