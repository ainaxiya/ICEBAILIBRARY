import crypto from "crypto";
import { db } from "./db";
import { getEmailConfig, sendTemplateMail, MailerError } from "./mailer";
import { getPublicSite } from "./settings";

// ─── P7 邮件验证码：发放 / 校验 ───
// 安全设计：
//   - 库内只存 sha256(code)，明文仅存在于邮件与内存
//   - 有效期 TTL / 重发冷却 / 同邮箱同用途每小时上限，全部取后台「邮箱服务」配置
//   - 校验失败计 attempts，≥5 次当前码作废（防暴力枚举 6 位数字）
//   - 消费即作废（consumedAt），一码只用一次

export type EmailCodePurpose = "register" | "reset";

const PURPOSE_TEMPLATE: Record<EmailCodePurpose, string> = {
  register: "register_code",
  reset: "reset_code",
};
const PURPOSE_REASON: Record<EmailCodePurpose, string> = {
  register: "注册账号",
  reset: "找回密码",
};
const MAX_ATTEMPTS = 5;

export class EmailCodeError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "EmailCodeError";
  }
}

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// 发放验证码：限流校验 → 生成入库 → 按模板发信
export async function issueEmailCode(email: string, purpose: EmailCodePurpose) {
  const cfg = await getEmailConfig();
  if (!cfg.enabled) {
    throw new EmailCodeError(503, "邮件服务未开启，请联系管理员在后台配置邮箱服务");
  }

  const ttlMin = clamp(cfg.codeTtlMinutes, 1, 60);
  const cooldownSec = clamp(cfg.resendCooldownSeconds, 30, 3600);
  const hourlyLimit = clamp(cfg.hourlySendLimit, 1, 30);

  const since = new Date(Date.now() - 3600_000);
  const recent = await db.emailCode.findMany({
    where: { email, purpose, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (recent.length > 0) {
    const sinceLastMs = Date.now() - recent[0].createdAt.getTime();
    if (sinceLastMs < cooldownSec * 1000) {
      const wait = Math.ceil((cooldownSec * 1000 - sinceLastMs) / 1000);
      throw new EmailCodeError(429, `发送过于频繁，请 ${wait} 秒后再试`);
    }
  }
  if (recent.length >= hourlyLimit) {
    throw new EmailCodeError(429, "该邮箱发送次数已达上限，请一小时后再试");
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await db.emailCode.create({
    data: {
      email,
      purpose,
      codeHash: hashCode(code),
      expiresAt: new Date(Date.now() + ttlMin * 60_000),
    },
  });

  const site = await getPublicSite();
  try {
    await sendTemplateMail(PURPOSE_TEMPLATE[purpose], email, {
      code,
      minutes: ttlMin,
      reason: PURPOSE_REASON[purpose],
      siteName: site.siteName,
      site: (process.env.NEXT_PUBLIC_SITE_URL || "https://www.icebai.com").replace(/\/$/, ""),
      year: new Date().getFullYear(),
    });
  } catch (e) {
    // 模板/服务配置类错误透出可读信息；发送记录保留（计数已占，防绕过限流）
    const msg = e instanceof MailerError ? e.message : "邮件发送失败，请稍后再试";
    throw new EmailCodeError(502, msg);
  }

  return { ttlMinutes: ttlMin, cooldownSeconds: cooldownSec };
}

// 校验验证码：通过则消费；失败计次数。错误信息刻意模糊（不区分过期/不存在），防枚举
export async function verifyEmailCode(email: string, purpose: EmailCodePurpose, code: string) {
  const normalized = (code || "").trim();
  if (!/^\d{6}$/.test(normalized)) {
    throw new EmailCodeError(400, "验证码格式不正确");
  }
  const row = await db.emailCode.findFirst({
    where: {
      email,
      purpose,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!row || row.attempts >= MAX_ATTEMPTS) {
    throw new EmailCodeError(400, "验证码无效或已过期，请重新获取");
  }
  if (row.codeHash !== hashCode(normalized)) {
    // 条件更新：只有 attempts 还没到上限时才 +1。
    // 并发错误提交会同时读到同一个旧 attempts，原子计数保证最多只记到上限，不会突破 5 次。
    const inc = await db.emailCode.updateMany({
      where: { id: row.id, consumedAt: null, attempts: { lt: MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (inc.count === 0) {
      throw new EmailCodeError(400, "验证码无效或已过期，请重新获取");
    }
    throw new EmailCodeError(400, "验证码错误");
  }
  // 条件消费：并发拿到同一正确码时只有一次能消费成功（防同一码多账号重复使用）。
  const consumed = await db.emailCode.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) {
    throw new EmailCodeError(400, "验证码无效或已过期，请重新获取");
  }
}
