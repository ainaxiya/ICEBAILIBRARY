import crypto from "crypto";
import { db } from "@/lib/db";

// ─── P5 站外双通道：站外会员 API Key ───
// 明文格式 sk-<48 hex>，只在创建时返回一次；库内仅存 sha256(keyHash) 与展示前缀。
// 校验：sha256 查表 → status=active → 未过期 → 账号 active；lastUsedAt 异步回写。

const PLAIN_PREFIX = "sk-";
const BODY_BYTES = 24; // 48 hex 字符
// 展示前缀：sk- + 前 8 位明文字符
const DISPLAY_LEN = 11;

export function hashApiKey(plain: string): string {
  return crypto.createHash("sha256").update(plain, "utf8").digest("hex");
}

// 创建 Key：返回明文（仅此一次）+ 落库行（name 为会员自定义名称，可空）
export async function createApiKey(
  userId: number,
  expiresAt?: Date | null,
  name?: string | null
): Promise<{ id: number; plaintext: string; keyPrefix: string; name: string | null; expiresAt: Date | null }> {
  const plaintext = PLAIN_PREFIX + crypto.randomBytes(BODY_BYTES).toString("hex");
  const row = await db.userApiKey.create({
    data: {
      userId,
      name: name?.trim() ? name.trim().slice(0, 50) : null,
      keyPrefix: plaintext.slice(0, DISPLAY_LEN),
      keyHash: hashApiKey(plaintext),
      expiresAt: expiresAt ?? null,
    },
  });
  return { id: row.id, plaintext, keyPrefix: row.keyPrefix, name: row.name, expiresAt: row.expiresAt };
}

// 吊销（幂等，仅限本人 Key）
export async function revokeApiKey(id: number, userId: number): Promise<boolean> {
  const r = await db.userApiKey.updateMany({
    where: { id, userId, status: "active" },
    data: { status: "revoked" },
  });
  return r.count > 0;
}

export interface VerifiedApiKey {
  key: { id: number; keyPrefix: string };
  user: {
    id: number;
    username: string;
    role: string;
    status: string;
    nickname: string | null;
    avatar: string | null;
    email: string | null;
    phone: string | null;
    bio: string | null;
    membershipLevel: string;
    membershipUntil: Date | null;
    allowPublish: boolean;
    commentBanned: boolean;
    createdAt: Date;
  };
}

// Bearer 明文校验：失败返回中文原因（调用方转 401）
export async function verifyApiKey(
  plaintext: string
): Promise<{ ok: true; key: VerifiedApiKey["key"]; user: VerifiedApiKey["user"] } | { ok: false; error: string }> {
  const row = await db.userApiKey.findUnique({ where: { keyHash: hashApiKey(plaintext) } });
  if (!row) return { ok: false, error: "API Key 无效" };
  if (row.status !== "active") return { ok: false, error: "API Key 已吊销" };
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "API Key 已过期" };
  }
  const user = await db.user.findUnique({
    where: { id: row.userId },
    select: {
      id: true, username: true, role: true, status: true, nickname: true, avatar: true,
      email: true, phone: true, bio: true, membershipLevel: true, membershipUntil: true,
      allowPublish: true, commentBanned: true, createdAt: true,
    },
  });
  if (!user || user.status !== "active") return { ok: false, error: "账号不可用" };

  // 回写 lastUsedAt（fire-and-forget，不阻塞调用）
  db.userApiKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { ok: true, key: { id: row.id, keyPrefix: row.keyPrefix }, user };
}
