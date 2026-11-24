import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { requirePerm, PERMISSIONS, logAdminAction, getClientIp } from "@/lib/rbac";
import { saveSetting, getSettings } from "@/lib/settings";
import { getEmailConfig, sendTemplateMail, MailerError } from "@/lib/mailer";
import { encryptSecret } from "@/lib/crypto";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// ─── P7 邮箱服务配置（后台「站点管理→邮箱服务」） ───
// GET：返回配置（SMTP 密码不回显，只给 hasPass）
// PUT：保存配置（smtpPass 留空 = 保持旧密码；非空则加密存储）
// POST：发送测试邮件（body: {to}）

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_READ);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const cfg = await getEmailConfig();
  return NextResponse.json({
    enabled: cfg.enabled,
    configured: cfg.configured,
    smtpHost: cfg.smtpHost,
    smtpPort: cfg.smtpPort,
    smtpSecure: !!cfg.smtpSecure,
    smtpUser: cfg.smtpUser,
    fromName: cfg.fromName,
    fromAddress: cfg.fromAddress,
    hasPass: !!cfg.smtpPassEnc,
    resetPasswordVerify: !!cfg.resetPasswordVerify,
    codeTtlMinutes: cfg.codeTtlMinutes,
    resendCooldownSeconds: cfg.resendCooldownSeconds,
    hourlySendLimit: cfg.hourlySendLimit,
  });
}

const putSchema = z.object({
  enabled: z.boolean(),
  smtpHost: z.string().trim().max(200).default(""),
  smtpPort: z.coerce.number().int().min(1).max(65535).default(587),
  smtpSecure: z.boolean().default(false),
  smtpUser: z.string().trim().max(200).default(""),
  smtpPass: z.string().max(200).optional().default(""),
  fromName: z.string().trim().max(100).default(""),
  fromAddress: z.union([
    z.string().trim().email("发件邮箱格式不正确").max(100),
    z.literal(""),
  ]).default(""),
  resetPasswordVerify: z.boolean().default(true),
  codeTtlMinutes: z.coerce.number().int().min(1).max(60).default(10),
  resendCooldownSeconds: z.coerce.number().int().min(30).max(3600).default(60),
  hourlySendLimit: z.coerce.number().int().min(1).max(30).default(5),
});

export async function PUT(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const d = parsed.data;
  // SMTP 主机清洗：误填协议头（https://xxx）或尾部斜杠 → 剥离为纯主机名（nodemailer 需要纯 host）
  const smtpHost = d.smtpHost.replace(/^https?:\/\//i, "").replace(/\/+$/, "");

  // 密码：留空保持旧值；填写则加密覆盖
  const current = await getSettings();
  const passEnc = d.smtpPass
    ? encryptSecret(d.smtpPass)
    : current.email.smtpPassEnc;

  await saveSetting("email", {
    enabled: d.enabled,
    smtpHost,
    smtpPort: d.smtpPort,
    smtpSecure: d.smtpSecure,
    smtpUser: d.smtpUser,
    smtpPassEnc: passEnc,
    fromName: d.fromName,
    fromAddress: d.fromAddress,
    resetPasswordVerify: d.resetPasswordVerify,
    codeTtlMinutes: d.codeTtlMinutes,
    resendCooldownSeconds: d.resendCooldownSeconds,
    hourlySendLimit: d.hourlySendLimit,
  });

  await logAdminAction({
    adminId: admin.id,
    action: "update",
    targetType: "email_config",
    detail: JSON.stringify({ enabled: d.enabled, smtpHost: d.smtpHost, passChanged: !!d.smtpPass }),
    ip: await getClientIp(),
  });
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });
  if (!rateLimit(`mail-test:${admin.id}`, 3, 60_000)) {
    return NextResponse.json({ error: "发送过于频繁，请一分钟后再试" }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const to = (body?.to || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return NextResponse.json({ error: "收件邮箱格式不正确" }, { status: 400 });
  }

  try {
    // 测试邮件使用演示变量：模板所有 {{var}} 均渲染为示例值（siteName/site/year 由 renderTemplate 公共注入）
    await sendTemplateMail("test_mail", to, {
      reason: "邮件服务测试",
      code: String(Math.floor(100000 + Math.random() * 900000)),
      minutes: 10,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof MailerError ? e.message : "发送失败";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
