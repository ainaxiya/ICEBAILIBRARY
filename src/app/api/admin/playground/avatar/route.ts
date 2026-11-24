import { NextRequest, NextResponse } from "next/server";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import {
  clearPlaygroundAvatar,
  getPlaygroundAvatar,
  savePlaygroundAvatar,
} from "@/lib/playground/avatar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = ["image/png", "image/jpeg", "image/webp"];

// 文件头校验：防止伪装扩展名（沿用后台上传的 magic 规则）
function magicOk(bytes: Buffer, mime: string): boolean {
  if (mime === "image/png") return bytes.subarray(0, 4).toString("hex") === "89504e47";
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/webp") {
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
      bytes.subarray(8, 12).toString("latin1") === "WEBP"
    );
  }
  return false;
}

export async function GET() {
  const { ok } = await requirePerm(PERMISSIONS.SETTING_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json(await getPlaygroundAvatar());
}

// POST：上传/替换虚拟角色头像
export async function POST(req: NextRequest) {
  const { user: admin, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!admin || !ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let file: File | null = null;
  try {
    const form = await req.formData();
    file = form.get("file") as File | null;
  } catch {
    return NextResponse.json({ error: "上传数据解析失败（可能超过服务器上传限制）" }, { status: 400 });
  }
  if (!file || file.size === 0) return NextResponse.json({ error: "缺少文件或文件为空" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "图片不能超过 2MB" }, { status: 400 });
  if (!ALLOWED.includes(file.type)) {
    return NextResponse.json({ error: `不支持的图片类型：${file.type || "未知"}` }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (!magicOk(bytes, file.type)) {
    return NextResponse.json({ error: "文件内容与类型不符（已拦截）" }, { status: 400 });
  }

  try {
    const saved = await savePlaygroundAvatar(bytes, file.type);
    await logAdminAction({
      adminId: admin.id,
      action: "update",
      targetType: "setting",
      detail: JSON.stringify({ avatar: saved.key, storage: saved.storage, size: file.size }),
      ip: await getClientIp(),
    });
    return NextResponse.json({ ok: true, ...saved });
  } catch (e) {
    const msg = (e as Error).message || "保存失败";
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: 500 });
  }
}

// DELETE：清除自定义头像，前台回退默认占位图
export async function DELETE() {
  const { user: admin, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!admin || !ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  await clearPlaygroundAvatar();
  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "setting",
    detail: JSON.stringify({ avatar: null }),
    ip: await getClientIp(),
  });
  return NextResponse.json({ ok: true });
}
