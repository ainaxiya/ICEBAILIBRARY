import { describe, it, expect, afterAll } from "vitest";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { activeUserState } from "@/lib/auth";
import { resolveEmailVerify } from "@/lib/settings";
import { verifyEmailCode } from "@/lib/email-codes";

// ─── a5 / a3 / a4 回归单测：封禁准入、邮箱验证口径、验证码并发计数 ───

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const emailOf = (tag: string) => `guard-${tag}-${Date.now()}@test.local`;

afterAll(async () => {
  await db.$disconnect();
});

describe("activeUserState（封禁态准入）", () => {
  it("未登录 → unauthorized", () => {
    expect(activeUserState(null)).toBe("unauthorized");
    expect(activeUserState(undefined)).toBe("unauthorized");
  });

  it("非 active 状态一律视为封禁 → suspended", () => {
    expect(activeUserState({ status: "banned" })).toBe("suspended");
    expect(activeUserState({ status: "disabled" })).toBe("suspended");
    expect(activeUserState({ status: null })).toBe("suspended");
  });

  it("active → ok", () => {
    expect(activeUserState({ status: "active" })).toBe("ok");
  });
});

describe("resolveEmailVerify（注册邮箱验证口径）", () => {
  it("未开启验证 → off（不看邮件服务）", () => {
    expect(resolveEmailVerify({ emailVerify: false }, { enabled: false })).toBe("off");
    expect(resolveEmailVerify({ emailVerify: false }, { enabled: true })).toBe("off");
  });

  it("开启验证且邮件服务可用 → on", () => {
    expect(resolveEmailVerify({ emailVerify: true }, { enabled: true })).toBe("on");
  });

  it("开启验证但邮件服务未启用 → misconfigured（显式拒绝，不静默放行）", () => {
    expect(resolveEmailVerify({ emailVerify: true }, { enabled: false })).toBe("misconfigured");
  });
});

describe("verifyEmailCode 并发计数", () => {
  it("并发错误提交最多计到 5 次，不会突破上限", async () => {
    const email = emailOf("wrong");
    const row = await db.emailCode.create({
      data: {
        email,
        purpose: "register",
        codeHash: sha256("123456"),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => verifyEmailCode(email, "register", "000000"))
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);

    const after = await db.emailCode.findUnique({ where: { id: row.id } });
    expect(after?.attempts).toBe(5);
    expect(after?.consumedAt).toBeNull();
  });

  it("同一正确验证码并发提交只消费一次", async () => {
    const email = emailOf("right");
    const row = await db.emailCode.create({
      data: {
        email,
        purpose: "register",
        codeHash: sha256("654321"),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => verifyEmailCode(email, "register", "654321"))
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const after = await db.emailCode.findUnique({ where: { id: row.id } });
    expect(after?.consumedAt).not.toBeNull();
  });
});
