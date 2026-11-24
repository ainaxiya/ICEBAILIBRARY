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
  name?: string | null,
  quotaCredits?: number | null,
  allowedModels?: string[] | null
): Promise<{
  id: number;
  plaintext: string;
  keyPrefix: string;
  name: string | null;
  expiresAt: Date | null;
  quotaCredits: number | null;
  allowedModels: string[];
}> {
  const plaintext = PLAIN_PREFIX + crypto.randomBytes(BODY_BYTES).toString("hex");
  const models = normalizeAllowedModels(allowedModels);
  const row = await db.userApiKey.create({
    data: {
      userId,
      name: name?.trim() ? name.trim().slice(0, 50) : null,
      keyPrefix: plaintext.slice(0, DISPLAY_LEN),
      keyHash: hashApiKey(plaintext),
      expiresAt: expiresAt ?? null,
      quotaCredits: quotaCredits ?? null,
      allowedModels: models,
    },
  });
  return {
    id: row.id,
    plaintext,
    keyPrefix: row.keyPrefix,
    name: row.name,
    expiresAt: row.expiresAt,
    quotaCredits: row.quotaCredits,
    allowedModels: row.allowedModels,
  };
}

// b1：白名单归一化（去空、去重、限 100 条 × 100 字符），空 = 不限制
export function normalizeAllowedModels(models?: string[] | null): string[] {
  if (!models?.length) return [];
  const seen = new Set<string>();
  for (const m of models) {
    const v = String(m ?? "").trim().slice(0, 100);
    if (v) seen.add(v);
    if (seen.size >= 100) break;
  }
  return [...seen];
}

// b1：Key 是否允许调用该模型（空白名单 = 全部允许）
export function apiKeyAllowsModel(allowedModels: string[] | null | undefined, model: string): boolean {
  if (!allowedModels?.length) return true;
  return allowedModels.includes(model);
}

// 吊销（幂等，仅限本人 Key）
export async function revokeApiKey(id: number, userId: number): Promise<boolean> {
  const r = await db.userApiKey.updateMany({
    where: { id, userId, status: "active" },
    data: { status: "revoked" },
  });
  return r.count > 0;
}

// b2：行内停用 / 启用（仅 active ↔ disabled；已吊销不可恢复）
export async function setApiKeyDisabled(
  id: number,
  userId: number,
  disabled: boolean
): Promise<boolean> {
  const r = await db.userApiKey.updateMany({
    where: { id, userId, status: disabled ? "active" : "disabled" },
    data: { status: disabled ? "disabled" : "active" },
  });
  return r.count > 0;
}

// b2 硬额度：额度读写拆到 apikey-quota（不含 crypto，避免 instrumentation 打包报错）
export {
  releaseApiKeyQuota,
  reserveApiKeyQuota,
  setApiKeyQuota,
} from "@/lib/apikey-quota";

export interface VerifiedApiKey {
  key: { id: number; keyPrefix: string; allowedModels: string[] };
  user: {
    id: number;
    username: string;
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
): Promise<
  | { ok: true; key: VerifiedApiKey["key"]; user: VerifiedApiKey["user"] }
  | { ok: false; error: string; quotaExceeded?: boolean }
> {
  const row = await db.userApiKey.findUnique({ where: { keyHash: hashApiKey(plaintext) } });
  if (!row) return { ok: false, error: "Invalid API key" };
  if (row.status !== "active") {
    return {
      ok: false,
      error: row.status === "disabled" ? "API key is disabled" : "API key has been revoked",
    };
  }
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "API key has expired" };
  }
  // b2 硬额度：鉴权侧先拦超额，返回明确错误码（402 key_quota_exceeded）
  if (row.quotaCredits != null && row.usedCredits >= BigInt(row.quotaCredits)) {
    return { ok: false, error: "API key quota exceeded", quotaExceeded: true };
  }
  const user = await db.user.findUnique({
    where: { id: row.userId },
    select: {
      id: true, username: true, status: true, nickname: true, avatar: true,
      email: true, phone: true, bio: true, membershipLevel: true, membershipUntil: true,
      allowPublish: true, commentBanned: true, createdAt: true,
      membership: { select: { isSystem: true } },
    },
  });
  if (!user || user.status !== "active") return { ok: false, error: "Account unavailable" };
  // 系统等级账号（采集号等）不开放站外网关调用
  if (user.membership?.isSystem) {
    return { ok: false, error: "Account level cannot use API keys" };
  }

  // 回写 lastUsedAt（fire-and-forget，不阻塞调用）
  db.userApiKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  // 对外返回剥离 membership 关联字段
  const { membership: _membership, ...userOut } = user;
  return {
    ok: true,
    key: { id: row.id, keyPrefix: row.keyPrefix, allowedModels: row.allowedModels },
    user: userOut,
  };
}
