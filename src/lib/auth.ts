import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { db } from "./db";
import { REAUTH_COOKIE, REAUTH_TTL_SECONDS, isValidReauthPayload } from "./reauth-core";

// ─── JWT 密钥（S0-1 安全加固） ───
// 会员与管理员使用独立密钥：JWT_SECRET / JWT_ADMIN_SECRET（后者未配置时回退前者并告警）。
// 生产环境缺 JWT_SECRET 直接抛错（fail-fast，见 src/instrumentation.ts 启动校验）；
// 开发环境回退 dev-secret 方便本地启动。密钥变更后旧令牌验签失败 = 自动全站下线重登录（令牌轮换）。

function encodeSecret(raw: string) {
  return new TextEncoder().encode(raw);
}

let userSecretCache: Uint8Array | null = null;
function userSecret(): Uint8Array {
  if (!userSecretCache) {
    const raw = process.env.JWT_SECRET;
    if (raw) {
      userSecretCache = encodeSecret(raw);
    } else if (process.env.NODE_ENV === "production") {
      throw new Error("[security] JWT_SECRET is required in production");
    } else {
      userSecretCache = encodeSecret("dev-secret");
    }
  }
  return userSecretCache;
}

let adminSecretCache: Uint8Array | null = null;
function adminSecret(): Uint8Array {
  if (!adminSecretCache) {
    const admin = process.env.JWT_ADMIN_SECRET;
    const base = process.env.JWT_SECRET;
    if (admin) {
      adminSecretCache = encodeSecret(admin);
    } else if (base) {
      if (process.env.NODE_ENV === "production") {
        console.warn("[security] JWT_ADMIN_SECRET not set; admin tokens fall back to JWT_SECRET (separate it in production)");
      }
      adminSecretCache = encodeSecret(base);
    } else if (process.env.NODE_ENV === "production") {
      throw new Error("[security] JWT_SECRET is required in production");
    } else {
      adminSecretCache = encodeSecret("dev-secret");
    }
  }
  return adminSecretCache;
}

// 会员与管理员使用各自独立的 Cookie，互不相通
const COOKIE = "token";
const ADMIN_COOKIE = "admin_token";

// 令牌有效期（天）：从 .env 读取，缺省与历史值一致（会员 30 天 / 管理员 7 天）
const USER_TOKEN_DAYS = Number(process.env.JWT_USER_TTL_DAYS) || 30;
const ADMIN_TOKEN_DAYS = Number(process.env.JWT_ADMIN_TTL_DAYS) || 7;

// ─── 会员 ───

export async function signToken(userId: number) {
  return new SignJWT({ uid: userId, t: "u" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${USER_TOKEN_DAYS}d`)
    .sign(userSecret());
}

export async function setAuthCookie(token: string) {
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: USER_TOKEN_DAYS * 24 * 60 * 60,
  });
}

export async function clearAuthCookie() {
  const store = await cookies();
  store.delete(COOKIE);
}

export async function getCurrentUser() {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, userSecret());
    if (payload.t !== "u") return null;
    const uid = payload.uid as number;
    if (!uid) return null;
    return await db.user.findUnique({
      where: { id: uid },
      select: {
        id: true, username: true, bio: true, nickname: true,
        avatar: true, email: true, phone: true,
        membershipLevel: true, membershipUntil: true, status: true,
        allowPublish: true, commentBanned: true,
        createdAt: true,
      },
    });
  } catch {
    return null;
  }
}

// ─── 站内接口准入：登录态 + 封禁态 ───
// 封禁用户的 JWT 仍然有效，只判登录态会让封号不止损（继续消耗积分与上游成本）。
// 纯函数便于单测，路由按自身错误体返回 401 / 403。
export type ActiveUserState = "ok" | "unauthorized" | "suspended";

export function activeUserState(user: { status?: string | null } | null | undefined): ActiveUserState {
  if (!user) return "unauthorized";
  return user.status === "active" ? "ok" : "suspended";
}

export async function getActiveUser() {
  const user = await getCurrentUser();
  const state = activeUserState(user);
  return { user: state === "ok" ? user : null, state };
}

// ─── 管理员 ───

export async function signAdminToken(adminId: number) {
  return new SignJWT({ aid: adminId, t: "a" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_TOKEN_DAYS}d`)
    .sign(adminSecret());
}

export async function setAdminAuthCookie(token: string) {
  const store = await cookies();
  store.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ADMIN_TOKEN_DAYS * 24 * 60 * 60,
  });
}

export async function clearAdminAuthCookie() {
  const store = await cookies();
  store.delete(ADMIN_COOKIE);
}

// 管理员对象（含权限位）。返回 null 表示未登录/已禁用
export async function getCurrentAdmin() {
  const store = await cookies();
  const token = store.get(ADMIN_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, adminSecret());
    if (payload.t !== "a") return null;
    const aid = payload.aid as number;
    if (!aid) return null;
    const admin = await db.adminAccount.findUnique({
      where: { id: aid },
      include: { adminRole: { select: { permissions: true, name: true } } },
    });
    if (!admin || admin.status !== "active") return null;
    return admin;
  } catch {
    return null;
  }
}

// 后台统一守卫：名称保持 requireAdmin，降低各 API 改造成本；
// 注意返回的是 AdminAccount（{ id, username, isSuper, adminRole... }），不是 User
export async function requireAdmin() {
  return getCurrentAdmin();
}

// ─── 敏感操作二次验证（b13） ───
// 重输密码后签发 10 分钟短期令牌写入独立 Cookie；敏感接口用 getReauthAdminId 强制校验。
// 令牌与登录令牌同密钥但 t=ra 区分，无法当登录令牌使用。

export async function signAdminReauthToken(adminId: number) {
  return new SignJWT({ aid: adminId, t: "ra" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${REAUTH_TTL_SECONDS}s`)
    .sign(adminSecret());
}

export async function setAdminReauthCookie(token: string) {
  const store = await cookies();
  store.set(REAUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: REAUTH_TTL_SECONDS,
  });
}

export async function clearAdminReauthCookie() {
  const store = await cookies();
  store.delete(REAUTH_COOKIE);
}

// 返回通过二次验证的管理员 ID；无令牌 / 过期 / 非本人 → null
export async function getReauthAdminId(): Promise<number | null> {
  const store = await cookies();
  const token = store.get(REAUTH_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, adminSecret());
    const aid = payload.aid as number;
    if (!isValidReauthPayload(payload as { t?: unknown; aid?: unknown; iat?: unknown }, aid)) return null;
    return aid;
  } catch {
    return null;
  }
}
