import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// PUT /api/user/password  修改当前用户密码（v0.92 #9）
export async function PUT(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const oldPassword = typeof body?.oldPassword === "string" ? body.oldPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";

  if (!oldPassword || !newPassword) {
    return NextResponse.json({ error: "请填写旧密码与新密码" }, { status: 400 });
  }
  if (newPassword.length < 6 || newPassword.length > 64) {
    return NextResponse.json({ error: "新密码长度需 6-64 位" }, { status: 400 });
  }
  if (newPassword === oldPassword) {
    return NextResponse.json({ error: "新密码不能与旧密码相同" }, { status: 400 });
  }

  const user = await db.user.findUnique({
    where: { id: currentUser.id },
    select: { passwordHash: true },
  });
  // 无密码账号（如采集导入）不允许通过旧密码改密
  if (!user?.passwordHash) {
    return NextResponse.json({ error: "该账号未设置密码，请联系管理员" }, { status: 400 });
  }
  if (!(await bcrypt.compare(oldPassword, user.passwordHash))) {
    return NextResponse.json({ error: "旧密码错误" }, { status: 400 });
  }

  await db.user.update({
    where: { id: currentUser.id },
    data: { passwordHash: await bcrypt.hash(newPassword, 10) },
  });

  return NextResponse.json({ ok: true });
}
