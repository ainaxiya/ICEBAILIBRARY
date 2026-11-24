import { NextRequest, NextResponse } from "next/server";
import { requirePerm } from "@/lib/rbac";
import { saveUpload } from "@/lib/upload-store.server";
import { kindForExt } from "@/lib/upload-naming";

export const dynamic = "force-dynamic";

// 软件安装包本地上传（仅后台，统一落 public/uploads/<YYYY-MM>/）
// 与 /api/upload（图片/视频，magic-byte 校验）不同：安装包类型繁杂无可靠魔数，
// 后台管理员场景按扩展名白名单 + 100MB 上限控制（nginx client_max_body_size 100m）
// 落盘类型名由 upload-naming 的扩展名映射决定（zip/exe/doc/pdf/txt/other…）
const ALLOWED_EXT = new Set([
  "zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz",
  "dmg", "pkg", "exe", "msi", "apk", "ipa", "deb", "rpm", "appimage",
  "iso", "img", "txt", "pdf", "md", "json",
  // 图标等图片同样走本接口，按扩展名映射为 image 类型落月份目录
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

  const saved = await saveUpload(kindForExt(ext), ext, Buffer.from(await file.arrayBuffer()));

  return NextResponse.json({ url: saved.url, size: file.size });
}
