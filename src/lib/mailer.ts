import nodemailer from "nodemailer";
import { db } from "./db";
import { decryptSecret } from "./crypto";
import { getSettings } from "./settings";

// ─── P7 邮件体系：SMTP 发信 + 可编辑模板渲染 ───
// 配置来源：后台「邮箱服务」页（SiteSetting key="email"），SMTP 密码 AES-256-GCM 密文存储。
// 模板来源：EmailTemplate 表（{{var}} 插值），首次使用自动种入默认模板，后台可编辑/停用。

export class MailerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailerError";
  }
}

// 邮箱服务配置（smtpPassEnc 永不解密下发到接口层，仅发信时解密）
export async function getEmailConfig() {
  const s = await getSettings();
  const e = s.email;
  const configured = !!(e.smtpHost?.trim() && e.smtpUser?.trim() && e.smtpPassEnc && e.fromAddress?.trim());
  return {
    ...e,
    // SMTP 主机清洗：兼容历史误填的协议头（https://xxx）与尾部斜杠（nodemailer 需要纯主机名）
    smtpHost: (e.smtpHost || "").replace(/^https?:\/\//i, "").replace(/\/+$/, ""),
    smtpPort: Number(e.smtpPort) || 587,
    codeTtlMinutes: Number(e.codeTtlMinutes) || 10,
    resendCooldownSeconds: Number(e.resendCooldownSeconds) || 60,
    hourlySendLimit: Number(e.hourlySendLimit) || 5,
    configured,
    // enabled 必须同时满足：总开关开 + SMTP 四要素齐全
    enabled: !!e.enabled && configured,
  };
}

// ─── 模板默认定义（key / 用途 / 可用变量） ───

export interface EmailTemplateDef {
  key: string;
  name: string;
  desc: string;
  vars: string[];
  subject: string;
  bodyHtml: string;
}

// 全蓝技能卡片风（对齐前台 SkillCard：深蓝渐变底 + #2563eb→#3b82f6 蓝渐变头部/按钮 + 圆角信息块）
const shell = (inner: string, siteName = "{{siteName}}") => `
<div style="background:linear-gradient(160deg,#0a1128 0%,#0d1a3a 55%,#0f2547 100%);padding:28px 12px;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;">
  <div style="max-width:560px;margin:0 auto;">
    <div style="background:linear-gradient(90deg,#2563eb,#3b82f6);border-radius:16px 16px 0 0;padding:18px 24px;">
      <span style="color:#ffffff;font-weight:700;font-size:18px;letter-spacing:1px;">${siteName}</span>
      <span style="float:right;color:#bfdbfe;font-size:12px;padding-top:5px;">AI 资料库 · 冰山</span>
    </div>
    <div style="background:linear-gradient(180deg,#101d3d,#0c1730);border:1px solid rgba(59,130,246,0.35);border-top:none;border-radius:0 0 16px 16px;padding:28px 24px;">
      ${inner}
    </div>
    <div style="padding:16px 8px;color:#5b7bb2;font-size:12px;line-height:1.8;text-align:center;">
      没有收到？请检查邮箱的垃圾邮件箱。<br/>
      本邮件由 {{siteName}} 系统自动发送，请勿直接回复（{{year}}）
    </div>
  </div>
</div>`;

const codeBlock = `
      <p style="margin:0 0 14px;color:#dbeafe;font-size:15px;">你好！你正在进行「{{reason}}」操作，验证码为：</p>
      <div style="text-align:center;margin:24px 0;">
        <span style="display:inline-block;font-size:34px;font-weight:800;letter-spacing:8px;color:#ffffff;background:linear-gradient(135deg,#2563eb,#3b82f6);border-radius:14px;padding:14px 24px;box-shadow:0 8px 24px rgba(37,99,235,0.35);">{{code}}</span>
      </div>
      <p style="margin:0 0 6px;color:#93b4f5;font-size:13px;">验证码 {{minutes}} 分钟内有效，请勿泄露给任何人。</p>
      <p style="margin:0;color:#5b7bb2;font-size:13px;">如果这不是你本人的操作，请忽略本邮件。</p>`;

export const EMAIL_TEMPLATES: EmailTemplateDef[] = [
  {
    key: "register_code",
    name: "注册验证码",
    desc: "注册需邮箱验证码开启时，发给新用户的验证码邮件",
    vars: ["code", "minutes", "reason", "siteName", "site", "year"],
    subject: "【{{siteName}}】注册验证码 {{code}}（{{minutes}} 分钟内有效）",
    bodyHtml: shell(codeBlock),
  },
  {
    key: "reset_code",
    name: "找回密码验证码",
    desc: "找回密码流程发给用户的验证码邮件",
    vars: ["code", "minutes", "reason", "siteName", "site", "year"],
    subject: "【{{siteName}}】找回密码验证码 {{code}}（{{minutes}} 分钟内有效）",
    bodyHtml: shell(codeBlock),
  },
  {
    key: "test_mail",
    name: "测试邮件",
    desc: "后台「邮箱服务」页「发送测试邮件」按钮使用",
    vars: ["siteName", "site", "year"],
    subject: "【{{siteName}}】邮件服务测试",
    bodyHtml: shell(`
      <p style="margin:0 0 12px;color:#dbeafe;font-size:15px;">这是一封测试邮件。</p>
      <p style="margin:0;color:#93b4f5;font-size:13px;">收到它说明 SMTP 配置正确，邮件服务可以投入使用。</p>`),
  },
  {
    key: "admin_alert",
    name: "运营告警通知",
    desc: "b16 告警按管理员分发：命中订阅的管理员收到此邮件",
    vars: ["alertTypeText", "level", "message", "time", "adminName", "siteName", "site", "year"],
    subject: "【{{siteName}}】{{level}}告警 · {{alertTypeText}}",
    bodyHtml: shell(`
      <p style="margin:0 0 12px;color:#dbeafe;font-size:15px;">{{adminName}}，你订阅的运营告警已触发：</p>
      <div style="background:rgba(37,99,235,0.14);border:1px solid rgba(59,130,246,0.35);border-radius:12px;padding:14px 16px;margin:0 0 14px;">
        <p style="margin:0 0 6px;color:#93c5fd;font-size:13px;">{{alertTypeText}} · {{level}} · {{time}}</p>
        <p style="margin:0;color:#e0f2fe;font-size:14px;line-height:1.8;">{{message}}</p>
      </div>
      <p style="margin:0;color:#5b7bb2;font-size:13px;">请登录后台「运营告警」页核对处理；确认仅消警，不会自动退款或补账。</p>`),
  },
];

// 首次使用自动种入默认模板（后台可改，改坏可回默认：清空 subject+body 保存即还原）
async function ensureTemplate(key: string) {
  let row = await db.emailTemplate.findUnique({ where: { key } });
  if (!row) {
    const def = EMAIL_TEMPLATES.find((t) => t.key === key);
    if (!def) throw new MailerError(`未知邮件模板：${key}`);
    row = await db.emailTemplate.create({
      data: { key, subject: def.subject, bodyHtml: def.bodyHtml, enabled: true },
    });
  }
  return row;
}

// 变量替换：{{var}} → 值（未提供的变量替换为空串，避免模板残留占位符）
function interpolate(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (_, k: string) => {
    const v = (vars as Record<string, unknown>)[k];
    return v === undefined || v === null ? "" : String(v);
  });
}

export async function renderTemplate(
  key: string,
  vars: Record<string, string | number>
): Promise<{ subject: string; html: string }> {
  const row = await ensureTemplate(key);
  if (!row.enabled) throw new MailerError("该邮件模板已停用");
  // 公共变量统一注入：siteName/site/year 所有模板可用，业务侧传同名变量可覆盖
  // year 显示为当前年月日（2026-11-11 格式，用户要求）
  const s = await getSettings();
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const common: Record<string, string | number> = {
    siteName: s.site?.siteName || s.basic?.siteName || "",
    site: (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/+$/, ""),
    year: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  };
  const merged = { ...common, ...vars };
  return {
    subject: interpolate(row.subject, merged),
    html: interpolate(row.bodyHtml, merged),
  };
}

// ─── 发信 ───

export async function sendTemplateMail(
  key: string,
  to: string,
  vars: Record<string, string | number>
): Promise<void> {
  const cfg = await getEmailConfig();
  if (!cfg.enabled) throw new MailerError("邮件服务未开启，请在后台「邮箱服务」中配置并启用");
  const { subject, html } = await renderTemplate(key, vars);

  const transporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: !!cfg.smtpSecure,
    auth: { user: cfg.smtpUser, pass: decryptSecret(cfg.smtpPassEnc) },
    // 邮件场景无大附件，5 分钟超时足够；连接池按单实例低频发信不启用
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });

  const fromName = cfg.fromName?.trim() || cfg.fromAddress;
  try {
    await transporter.sendMail({
      from: `"${fromName}" <${cfg.fromAddress}>`,
      to,
      subject,
      html,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new MailerError(`SMTP 发送失败：${msg.slice(0, 200)}`);
  } finally {
    transporter.close();
  }
}
