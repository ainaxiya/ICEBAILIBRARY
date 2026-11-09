import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { db } from "./db";

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

// ─── 会员 ───

export async function signToken(userId: number) {
  return new SignJWT({ uid: userId, t: "u" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(userSecret());
}

export async function setAuthCookie(token: string) {
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
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
        id: true, username: true, role: true, bio: true, nickname: true,
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

// ─── 管理员 ───

export async function signAdminToken(adminId: number) {
  return new SignJWT({ aid: adminId, t: "a" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(adminSecret());
}

export async function setAdminAuthCookie(token: string) {
  const store = await cookies();
  store.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
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
