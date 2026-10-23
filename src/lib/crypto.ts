import crypto from "crypto";

// AES-256-GCM 字段级加密（存储桶 SecretKey 等敏感配置）
// 密文格式：enc:v1:<iv_b64>:<tag_b64>:<cipher_b64>
// 密钥来源：环境变量 STORAGE_KEY_SECRET（任意字符串，内部 sha256 归一为 32 字节）

const PREFIX = "enc:v1:";

function getKey(): Buffer {
  const raw = process.env.STORAGE_KEY_SECRET || process.env.JWT_SECRET || "";
  if (!raw) throw new Error("STORAGE_KEY_SECRET 未配置");
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // 兼容历史明文
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("密文格式错误");
  const [ivB64, tagB64, cipherB64] = parts;
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(cipherB64, "base64")), decipher.final()]).toString("utf8");
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX);
}
