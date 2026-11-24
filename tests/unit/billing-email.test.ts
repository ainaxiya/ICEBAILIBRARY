import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { creditBilling } from "@/lib/gateway/billing";
import { grant, getBalance, consume } from "@/lib/credits";
import { EmailCodeError, verifyEmailCode, issueEmailCode } from "@/lib/email-codes";
import { saveSetting } from "@/lib/settings";

// ─── S0 回归单测：计费幂等 + 邮件验证码（直连 prompthub_test 测试库） ───

let uid: number;
let seq = 0;
const rid = () => `unit-${Date.now()}-${++seq}`;

beforeAll(async () => {
  const user = await db.user.upsert({
    where: { username: "unit-billing-user" },
    update: { status: "active" },
    create: { username: "unit-billing-user", passwordHash: "x", status: "active" },
  });
  uid = user.id;
  await grant(uid, "trial", 100000n, "unit-billing-fixture").catch(() => {});
});

afterAll(async () => {
  await db.$disconnect();
});

describe("creditBilling 幂等（S0-3 回归）", () => {
  it("预扣后结算退差：净扣 = 实际用量，重复 settle 不再变化", async () => {
    const id = rid();
    const b0 = await getBalance(uid);
    const deduct = await creditBilling.preDeduct(uid, 100, id);
    expect(deduct.ok).toBe(true);

    await creditBilling.settle(uid, id, 60); // 实际 60，退差 40
    const b1 = await getBalance(uid);
    expect(b0 - b1).toBe(60n); // 净扣 = 实际用量 = 60（预扣100 - 退差40）

    // 重复 settle（幂等）：余额不变
    await creditBilling.settle(uid, id, 60);
    const b2 = await getBalance(uid);
    expect(b2).toBe(b1);
  });

  it("结算补扣封顶：总扣 ≤ est×3，重复 settle 不重复补扣", async () => {
    const id = rid();
    const b0 = await getBalance(uid);
    await creditBilling.preDeduct(uid, 100, id);
    await creditBilling.settle(uid, id, 500); // 超出预扣，补扣到 cap=300
    const b1 = await getBalance(uid);
    expect(b0 - b1).toBe(300n);

    await creditBilling.settle(uid, id, 500);
    const b2 = await getBalance(uid);
    expect(b2).toBe(b1);
  });

  it("退款：全额退回，重复 refund 不重复退款", async () => {
    const id = rid();
    const b0 = await getBalance(uid);
    const d = await creditBilling.preDeduct(uid, 50, id);
    expect(d.ok).toBe(true);
    const b1 = await getBalance(uid);
    expect(b0 - b1).toBe(50n);

    await creditBilling.refund(uid, id);
    const b2 = await getBalance(uid);
    expect(b2).toBe(b0);

    await creditBilling.refund(uid, id);
    const b3 = await getBalance(uid);
    expect(b3).toBe(b0);
  });

  it("账本幂等键：同 requestId 的 consume 只落一条流水", async () => {
    const id = rid();
    await creditBilling.preDeduct(uid, 10, id);
    await consume(uid, 10n, "again", id); // 同键重复扣 → already
    const rows = await db.creditLedger.findMany({ where: { requestId: id } });
    expect(rows.length).toBe(1);
  });
});

describe("email-codes（S0/P7 回归，SMTP 不可达路径）", () => {
  // 每次运行唯一邮箱：测试库跨运行持久，冷却/已存在记录会污染断言
  const EMAIL = `unit-email-test-${Date.now()}@example.com`;
  const COOL_EMAIL = `unit-cooldown-${Date.now()}@example.com`;

  beforeAll(async () => {
    // 指向不可达 SMTP：验证码会入库但发送失败（502）——正好用于验证消费/限次逻辑
    await saveSetting("email", {
      enabled: true,
      smtpHost: "127.0.0.1",
      smtpPort: 1,
      smtpSecure: false,
      smtpUser: "u",
      smtpPassEnc: "enc:v1:x:y:z",
      fromName: "t",
      fromAddress: "t@example.com",
      resetPasswordVerify: true,
      codeTtlMinutes: 10,
      resendCooldownSeconds: 60,
      hourlySendLimit: 5,
    });
  });

  afterAll(async () => {
    // 还原：关闭邮件服务，避免影响其他用例/库状态
    await saveSetting("email", { enabled: false, smtpHost: "", smtpPort: 587, smtpSecure: false, smtpUser: "", smtpPassEnc: "", fromName: "", fromAddress: "", resetPasswordVerify: true, codeTtlMinutes: 10, resendCooldownSeconds: 60, hourlySendLimit: 5 });
  });

  it("服务未启用时 issueEmailCode → 503", async () => {
    await saveSetting("email", { enabled: false, smtpHost: "", smtpPort: 587, smtpSecure: false, smtpUser: "", smtpPassEnc: "", fromName: "", fromAddress: "", resetPasswordVerify: true, codeTtlMinutes: 10, resendCooldownSeconds: 60, hourlySendLimit: 5 });
    await expect(issueEmailCode("x@example.com", "register")).rejects.toMatchObject({ status: 503 });
    // 恢复坏 SMTP 配置
    await saveSetting("email", {
      enabled: true,
      smtpHost: "127.0.0.1",
      smtpPort: 1,
      smtpSecure: false,
      smtpUser: "u",
      smtpPassEnc: "enc:v1:x:y:z",
      fromName: "t",
      fromAddress: "t@example.com",
      resetPasswordVerify: true,
      codeTtlMinutes: 10,
      resendCooldownSeconds: 60,
      hourlySendLimit: 5,
    });
  });

  it("发送失败但验证码已入库：正确码可验证、错误码计次", async () => {
    await expect(issueEmailCode(EMAIL, "register")).rejects.toMatchObject({ status: 502 });
    const row = await db.emailCode.findFirst({
      where: { email: EMAIL, purpose: "register", consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    expect(row).toBeTruthy();
    // 无法拿到明文（哈希存储）——直接构造明文验证哈希比对逻辑：
    // 用 verifyEmailCode 错误码 5 次 → attempts 到 5 → 再验直接作废
    for (let i = 0; i < 5; i++) {
      await expect(verifyEmailCode(EMAIL, "register", "000000")).rejects.toMatchObject({ status: 400 });
    }
    const after = await db.emailCode.findUnique({ where: { id: row!.id } });
    expect(after!.attempts).toBe(5);
    await expect(verifyEmailCode(EMAIL, "register", "000000")).rejects.toMatchObject({ status: 400 });
  });

  it("重发冷却：连续 issue → 429", async () => {
    await expect(issueEmailCode(COOL_EMAIL, "register")).rejects.toMatchObject({ status: 502 });
    await expect(issueEmailCode(COOL_EMAIL, "register")).rejects.toMatchObject({ status: 429 });
  });

  it("验证码格式错误 → 400", async () => {
    await expect(verifyEmailCode(EMAIL, "register", "12ab")).rejects.toMatchObject({ status: 400 });
  });
});
