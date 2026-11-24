import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { saveUpload } from "@/lib/upload-store.server";

export const dynamic = "force-dynamic";

const MAX_SIZE = 5 * 1024 * 1024; // 5MB

// 简单文件头校验（与前台头像上传一致）
function sniffImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")
    return true;
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP")
    return true;
  return false;
}

// POST /api/admin/users/:id/avatar/upload  后台上传/替换会员头像
// 复用前台规则：sharp 压成 256×256 webp，落既有上传目录；成功后直接写回该会员 avatar
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { admin, ok } = await requirePerm(PERMISSIONS.USER_WRITE);
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const uid = parseInt(id);
  const target = await db.user.findUnique({
    where: { id: uid },
    select: { id: true, membership: { select: { isSystem: true } } },
  });
  if (!target || target.membership?.isSystem) {
    return NextResponse.json({ error: "会员不存在" }, { status: 404 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no file" }, { status: 400 });
  if (file.size > MAX_SIZE) return NextResponse.json({ error: "文件过大（最大 5MB）" }, { status: 413 });
  if (file.size < 12) return NextResponse.json({ error: "invalid file" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  if (!sniffImage(buf)) {
    return NextResponse.json({ error: "unsupported file type, only image allowed" }, { status: 400 });
  }

  try {
    const processed = await sharp(buf)
      .resize(256, 256, { fit: "cover", position: "centre" })
      .webp({ quality: 82 })
      .toBuffer();
    const saved = await saveUpload("image", "webp", processed);

    await db.user.update({ where: { id: uid }, data: { avatar: saved.url } });
    await logAdminAction({
      adminId: admin.id,
      action: "update",
      targetType: "user",
      targetId: uid,
      detail: JSON.stringify({ avatar: saved.url }),
      ip: (await getClientIp()) || undefined,
    });

    return NextResponse.json({ url: saved.url, type: "image", size: processed.length });
  } catch (e) {
    console.error("[admin/avatar/upload] failed:", e);
    return NextResponse.json({ error: "图片处理失败，请更换图片后重试" }, { status: 500 });
  }
}
