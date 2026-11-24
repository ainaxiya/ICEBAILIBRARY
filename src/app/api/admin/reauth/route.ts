import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  requireAdmin,
  signAdminReauthToken,
  setAdminReauthCookie,
  clearAdminReauthCookie,
  getReauthAdminId,
} from "@/lib/auth";
import { db } from "@/lib/db";
import { logAdminAction, getClientIp } from "@/lib/rbac";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { REAUTH_TTL_SECONDS } from "@/lib/reauth-core";

export const dynamic = "force-dynamic";

// GET /api/admin/reauth — 当前管理员是否处于二次验证有效期内
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const ra = await getReauthAdminId();
  return NextResponse.json({ active: ra === admin.id, ttl: REAUTH_TTL_SECONDS });
}

// POST /api/admin/reauth — 重输当前管理员密码，换取 10 分钟敏感操作令牌
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // 防爆破：同一管理员 + IP 每分钟 6 次
  if (!rateLimit(`admin-reauth:${admin.id}:${clientIp(req)}`, 6, 60_000)) {
    return NextResponse.json({ error: "验证过于频繁，请稍后再试" }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const password = (body as { password?: unknown } | null)?.password;
  if (typeof password !== "string" || !password || password.length > 128) {
    return NextResponse.json({ error: "请输入当前管理员密码" }, { status: 400 });
  }

  const row = await db.adminAccount.findUnique({
    where: { id: admin.id },
    select: { passwordHash: true },
  });
  if (!row || !(await bcrypt.compare(password, row.passwordHash))) {
    return NextResponse.json({ error: "密码错误" }, { status: 401 });
  }

  await setAdminReauthCookie(await signAdminReauthToken(admin.id));
  await logAdminAction({
    adminId: admin.id,
    action: "reauth",
    targetType: "admin",
    targetId: admin.id,
    ip: (await getClientIp()) || undefined,
  });
  return NextResponse.json({ ok: true, ttl: REAUTH_TTL_SECONDS });
}

// DELETE /api/admin/reauth — 主动结束二次验证（登出时一并清理）
export async function DELETE() {
  await clearAdminReauthCookie();
  return NextResponse.json({ ok: true });
}
