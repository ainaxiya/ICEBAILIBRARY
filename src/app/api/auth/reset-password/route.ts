import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { verifyEmailCode, EmailCodeError } from "@/lib/email-codes";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// POST /api/auth/reset-password —— 找回密码（邮箱验证码）
// 前提：后台「邮箱服务」启用 + resetPasswordVerify 开启
// 成功后不自动登录（未登录态）；已有登录态不强制失效（JWT 自然到期）
export async function POST(req: NextRequest) {
  if (!rateLimit(`reset-pw:${clientIp(req)}`, 6, 600_000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }

  const site = await getSettings();
  if (!site.email.enabled || !site.email.resetPasswordVerify) {
    return NextResponse.json({ error: "未开启邮箱找回密码功能" }, { status: 400 });
  }

  const schema = z.object({
    email: z.string().email("邮箱格式不正确").max(100),
    code: z.string().regex(/^\d{6}$/, "验证码格式不正确"),
    newPassword: z.string().min(6, "密码至少 6 位").max(72),
  });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { email, code, newPassword } = parsed.data;

  const user = await db.user.findUnique({ where: { email }, select: { id: true, status: true } });
  // 用户不存在/被禁用：不消费验证码，返回与成功一致的提示防枚举
  if (!user || user.status !== "active") {
    return NextResponse.json({ ok: true });
  }

  try {
    await verifyEmailCode(email, "reset", code);
  } catch (e) {
    if (e instanceof EmailCodeError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  await db.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(newPassword, 10) },
  });
  return NextResponse.json({ ok: true });
}
