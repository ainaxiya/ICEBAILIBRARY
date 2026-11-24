import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { issueEmailCode, EmailCodeError, type EmailCodePurpose } from "@/lib/email-codes";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// POST /api/auth/send-code —— 发送邮件验证码（注册 / 找回密码）
// 防滥用：IP 限流 + 后台配置的冷却/每小时上限（email-codes 内）；找回密码不暴露邮箱是否存在
export async function POST(req: NextRequest) {
  if (!rateLimit(`send-code:${clientIp(req)}`, 10, 600_000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }

  const schema = z.object({
    email: z.string().email("邮箱格式不正确").max(100),
    purpose: z.enum(["register", "reset"]),
  });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { email, purpose } = parsed.data;
  const site = await getSettings();

  if (purpose === "register") {
    if (!site.register.allowRegister) {
      return NextResponse.json({ error: "registration closed" }, { status: 403 });
    }
    if (!site.register.emailVerify) {
      return NextResponse.json({ error: "注册未开启邮箱验证" }, { status: 400 });
    }
    // 注册场景提前查重，避免用户验证码都填了才提示邮箱已注册
    const dup = await db.user.findUnique({ where: { email } });
    if (dup) return NextResponse.json({ error: "邮箱已被注册" }, { status: 409 });
  } else {
    if (!site.email.resetPasswordVerify) {
      return NextResponse.json({ error: "未开启找回密码邮箱验证" }, { status: 400 });
    }
    // 找回密码：邮箱不存在时静默成功（不发送），防账号枚举
    const user = await db.user.findUnique({ where: { email }, select: { id: true, status: true } });
    if (!user || user.status !== "active") {
      return NextResponse.json({ ok: true, ttlMinutes: Number(site.email.codeTtlMinutes) || 10 });
    }
  }

  try {
    const r = await issueEmailCode(email, purpose as EmailCodePurpose);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof EmailCodeError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[send-code] unexpected:", e);
    return NextResponse.json({ error: "发送失败，请稍后再试" }, { status: 500 });
  }
}
