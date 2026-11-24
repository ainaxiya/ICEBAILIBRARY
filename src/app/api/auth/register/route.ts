import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { signToken, setAuthCookie } from "@/lib/auth";
import { getPublicSite, getSettings, resolveEmailVerify } from "@/lib/settings";
import { randomNickname } from "@/lib/random-name";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { verifyEmailCode, EmailCodeError } from "@/lib/email-codes";
import { getCreditsConfig, grant } from "@/lib/credits";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // 防批量注册：每 IP 每 10 分钟最多 8 次
  if (!rateLimit(`register:${clientIp(req)}`, 8, 600_000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }
  const site = await getPublicSite();
  if (!site.allowRegister) {
    return NextResponse.json({ error: "registration closed" }, { status: 403 });
  }

  const body = await req.json().catch(() => null) || {};
  const fields = site.registerFields;

  // P7 邮箱验证码开启：邮箱强制必填（忽略后台字段收集策略），并要求验证码
  // 判定只认注册设置本身；邮件服务未启用属于配置错误 → 显式拒绝，绝不静默跳过验证
  const full = await getSettings();
  const emailVerifyMode = resolveEmailVerify(full.register, full.email);
  if (emailVerifyMode === "misconfigured") {
    return NextResponse.json(
      { error: "邮件服务未启用，暂时无法完成邮箱验证注册，请联系管理员" },
      { status: 503 }
    );
  }
  const emailVerifyOn = emailVerifyMode === "on";

  // 按后台「注册设置」动态构造校验：账号/密码恒必填，其他字段按 off/optional/required
  const schemaShape: Record<string, z.ZodTypeAny> = {
    username: z
      .string()
      .min(3, "用户名 3-20 位（字母、数字、下划线、连字符）")
      .max(20)
      .regex(/^[A-Za-z0-9_\-]+$/, "用户名只能包含字母、数字、下划线、连字符"),
    password: z.string().min(6, "密码至少 6 位").max(72),
  };
  const emailRule = z.string().email("邮箱格式不正确").max(100);
  const phoneRule = z
    .string()
    .trim()
    .regex(/^[0-9+\-\s]{6,20}$/, "手机号格式不正确");
  const nicknameRule = z.string().trim().min(1, "昵称不能为空").max(20);

  if (emailVerifyOn) {
    schemaShape.email = emailRule;
    schemaShape.code = z.string().regex(/^\d{6}$/, "请输入 6 位邮箱验证码");
  } else if (fields.email === "required") schemaShape.email = emailRule;
  else if (fields.email === "optional") schemaShape.email = emailRule.or(z.literal("")).optional();
  if (fields.phone === "required") schemaShape.phone = phoneRule;
  else if (fields.phone === "optional") schemaShape.phone = phoneRule.or(z.literal("")).optional();
  if (fields.nickname === "required") schemaShape.nickname = nicknameRule;
  else if (fields.nickname === "optional") schemaShape.nickname = nicknameRule.or(z.literal("")).optional();

  const parsed = z.object(schemaShape).safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "注册信息有误" }, { status: 400 });
  }
  const d = parsed.data as {
    username: string;
    password: string;
    email?: string;
    phone?: string;
    nickname?: string;
    code?: string;
  };

  // 账号唯一（会员 + 管理员表都不能重名）
  const existsUser = await db.user.findFirst({ where: { username: d.username } });
  if (existsUser) return NextResponse.json({ error: "用户名已被占用" }, { status: 409 });
  const existsAdmin = await db.adminAccount.findUnique({ where: { username: d.username } });
  if (existsAdmin) return NextResponse.json({ error: "用户名已被占用" }, { status: 409 });

  const email = d.email?.trim() || null;
  const phone = d.phone?.trim() || null;
  // 未填昵称时按界面语言自动取随机名（中文界面→中文名，英文界面→英文名）
  const locale = typeof (body as Record<string, unknown>).locale === "string" ? ((body as Record<string, unknown>).locale as string) : "zh";
  const nickname = d.nickname?.trim() || randomNickname(locale);

  if (email) {
    const dup = await db.user.findUnique({ where: { email } });
    if (dup) return NextResponse.json({ error: "邮箱已被注册" }, { status: 409 });
  }
  if (phone) {
    const dup = await db.user.findUnique({ where: { phone } });
    if (dup) return NextResponse.json({ error: "手机号已被注册" }, { status: 409 });
  }

  // P7 邮箱验证码校验（放在所有前置校验之后，验证码最后消费，避免白扣）
  if (emailVerifyOn) {
    try {
      await verifyEmailCode(email!, "register", d.code!);
    } catch (e) {
      if (e instanceof EmailCodeError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }
  }

  const user = await db.user.create({
    data: {
      username: d.username,
      passwordHash: await bcrypt.hash(d.password, 10),
      email,
      phone,
      nickname,
      // 邮箱验证码注册通过即视为已验证（邮箱注册后锁定不可修改）
      emailVerified: !!(email && emailVerifyOn),
      status: "active",
      allowPublish: true,
      registerIp: clientIp(req),
    },
  });
  // P2 注册赠送积分（SiteSetting key="credits_config"，默认关闭不发放）
  try {
    const cfg = await getCreditsConfig();
    if (cfg.trialEnabled && cfg.trialCredits > 0) {
      await grant(user.id, "trial", BigInt(cfg.trialCredits), `register:${user.id}`);
    }
  } catch (e) {
    console.error("trial grant error:", e);
  }

  await setAuthCookie(await signToken(user.id));
  return NextResponse.json({ id: user.id, username: user.username });
}
