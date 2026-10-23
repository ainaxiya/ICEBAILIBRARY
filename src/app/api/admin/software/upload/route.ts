import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { requirePerm } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// 软件安装包本地上传（仅后台，存 public/uploads/soft/）
// 与 /api/upload（图片/视频，magic-byte 校验）不同：安装包类型繁杂无可靠魔数，
// 后台管理员场景按扩展名白名单 + 100MB 上限控制（nginx client_max_body_size 100m）
const ALLOWED_EXT = new Set([
  "zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz",
  "dmg", "pkg", "exe", "msi", "apk", "ipa", "deb", "rpm", "appimage",
  "iso", "img", "txt", "pdf", "md", "json",
  // 图标等图片（走 /uploads/soft/ 复用目录，便于表单统一调用）
  "jpg", "jpeg", "png", "webp", "gif",
]);
const MAX_MB = 100;

export async function POST(req: NextRequest) {
  const { ok } = await requirePerm("software:manage");
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file" }, { status: 400 });
  }
  if (file.size > MAX_MB * 1024 * 1024) {
    return NextResponse.json({ error: `文件超过 ${MAX_MB}MB 上限（大文件请用对象存储直传）` }, { status: 413 });
  }

  const rawName = file.name || "file";
  const ext = (rawName.split(".").pop() || "").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json({ error: `不支持的文件类型 .${ext}` }, { status: 400 });
  }

  const dir = path.join(process.cwd(), "public", "uploads", "soft");
  await mkdir(dir, { recursive: true });
  const safeBase = rawName.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-").slice(0, 40) || "file";
  const name = `${safeBase}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  await writeFile(path.join(dir, name), Buffer.from(await file.arrayBuffer()));

  return NextResponse.json({ url: `/uploads/soft/${name}`, size: file.size });
}
