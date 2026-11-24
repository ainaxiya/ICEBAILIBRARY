import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, storageKeySecretStatus } from "@/lib/crypto";

// o4：独立密钥优先；缺失时解密回退 JWT_SECRET 兼容历史密文，新加密必须用独立密钥。
const ORIG_STORAGE = process.env.STORAGE_KEY_SECRET;
const ORIG_JWT = process.env.JWT_SECRET;

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  delete process.env.STORAGE_KEY_SECRET;
  delete process.env.JWT_SECRET;
});

afterEach(() => {
  restore("STORAGE_KEY_SECRET", ORIG_STORAGE);
  restore("JWT_SECRET", ORIG_JWT);
});

describe("o4 STORAGE_KEY_SECRET 独立密钥", () => {
  it("配置独立密钥时报告 configured 且不使用 JWT 回退", () => {
    process.env.STORAGE_KEY_SECRET = "dedicated-secret";
    process.env.JWT_SECRET = "jwt-secret";
    expect(storageKeySecretStatus()).toEqual({ configured: true, usingJwtFallback: false });
    const cipher = encryptSecret("sk-test");
    expect(decryptSecret(cipher)).toBe("sk-test");
  });

  it("缺失独立密钥时报告回退；新加密直接拒绝（不再写入 JWT 派生密钥的密文）", () => {
    process.env.JWT_SECRET = "jwt-secret";
    expect(storageKeySecretStatus()).toEqual({ configured: false, usingJwtFallback: true });
    expect(() => encryptSecret("sk-test")).toThrow("STORAGE_KEY_SECRET 未配置");
  });

  it("解密仍可打开历史 JWT_SECRET 派生的密文", () => {
    process.env.JWT_SECRET = "jwt-secret";
    // 手工按旧逻辑（sha256(JWT_SECRET)）生成密文
    const key = crypto.createHash("sha256").update("jwt-secret", "utf8").digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update("legacy-key", "utf8"), cipher.final()]);
    const stored = `enc:v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
    expect(decryptSecret(stored)).toBe("legacy-key");
  });

  it("两个密钥都缺失时状态为未配置且不回退", () => {
    expect(storageKeySecretStatus()).toEqual({ configured: false, usingJwtFallback: false });
    expect(() => encryptSecret("x")).toThrow("STORAGE_KEY_SECRET 未配置");
  });
});
