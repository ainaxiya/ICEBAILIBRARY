import { db } from "./db";
import { getCurrentAdmin, getReauthAdminId } from "./auth";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { PERMISSIONS, ALL_PERMISSIONS, PERMISSION_GROUPS } from "./permissions";
import { REAUTH_REQUIRED_CODE } from "./reauth-core";

// 重新导出（服务端组件可用）
export { PERMISSIONS, ALL_PERMISSIONS, PERMISSION_GROUPS };
// 客户端组件请 import from "@/lib/permissions"

export type Permission = string;

// ─── 权限检查（管理员独立体系） ───
export async function getAdminPermissions(adminId: number): Promise<Set<string>> {
  const admin = await db.adminAccount.findUnique({
    where: { id: adminId },
    select: { isSuper: true, status: true, adminRole: { select: { permissions: true } } },
  });
  if (!admin || admin.status !== "active") return new Set();
  if (admin.isSuper || !admin.adminRole) return new Set(ALL_PERMISSIONS);
  return new Set(admin.adminRole.permissions);
}

export async function adminHasPermission(adminId: number, perm: Permission): Promise<boolean> {
  const perms = await getAdminPermissions(adminId);
  return perms.has("*") || perms.has(perm);
}

// ─── 在 API 路由中校验权限 ───
// 返回的 admin 是 AdminAccount（含 isSuper/adminRole）
export async function requirePerm(perm: Permission) {
  const admin = await getCurrentAdmin();
  if (!admin) return { admin: null, user: null, ok: false } as const;
  if (admin.isSuper) return { admin, user: admin, ok: true } as const;
  const perms = new Set(admin.adminRole?.permissions || []);
  const ok = perms.has("*") || perms.has(perm);
  return { admin, user: admin, ok } as const;
}

// ─── b13 敏感操作：权限校验 + 10 分钟内二次密码验证 ───
// needReauth=true 时路由返回 reauthRequired()（403 + code=REAUTH_REQUIRED），前端弹窗重输密码后重试。
export async function requireSensitivePerm(perm: Permission) {
  const r = await requirePerm(perm);
  if (!r.ok || !r.admin) return { ...r, needReauth: false } as const;
  const reauthAdminId = await getReauthAdminId();
  return { ...r, needReauth: reauthAdminId !== r.admin.id } as const;
}

// 已登录管理员的二次验证是否仍在有效期内（超管专用接口直接调用）
export async function hasRecentReauth(adminId: number): Promise<boolean> {
  return (await getReauthAdminId()) === adminId;
}

export function reauthRequired() {
  return NextResponse.json(
    { error: "敏感操作需二次验证，请输入当前管理员密码", code: REAUTH_REQUIRED_CODE },
    { status: 403 },
  );
}

// ─── 操作日志（只增不删，新日志一律挂 adminId） ───
export async function logAdminAction(params: {
  adminId: number;
  action: string;
  targetType?: string;
  targetId?: number;
  detail?: string;
  ip?: string;
}) {
  try {
    await db.adminLog.create({
      data: {
        adminId: params.adminId,
        action: params.action,
        targetType: params.targetType ?? null,
        targetId: params.targetId ?? null,
        detail: params.detail ?? null,
        ip: params.ip ?? null,
      },
    });
  } catch (e) {
    console.error("logAdminAction error:", e);
  }
}

// 从请求头获取 IP（S0-6：取 XFF 最后一跳 = 本站 Nginx 追加的真实来源，防伪造）
export async function getClientIp(): Promise<string | undefined> {
  const h = await headers();
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return h.get("x-real-ip") || undefined;
}

// ─── 初始化默认角色（首次启动时调用） ───
export async function ensureDefaultRoles() {
  const count = await db.adminRole.count();
  if (count > 0) return;

  await db.adminRole.createMany({
    data: [
      {
        name: "超级管理员",
        permissions: ["*"],
        description: "拥有全部权限",
      },
      {
        name: "内容管理员",
        permissions: ["prompt:read", "prompt:write", "prompt:delete", "prompt:feature", "prompt:batch", "category:read", "category:write", "comment:read", "comment:moderate", "crawl:manage", "skill:manage", "software:manage", "optimizerlog:read"],
        description: "管理提示词、分类、评论",
      },
      {
        name: "用户管理员",
        permissions: ["user:read", "user:write", "user:delete", "log:read"],
        description: "管理用户和查看日志",
      },
      {
        name: "审计员",
        permissions: ["log:read", "prompt:read", "user:read"],
        description: "只读权限，仅查看",
      },
    ],
  });
}
