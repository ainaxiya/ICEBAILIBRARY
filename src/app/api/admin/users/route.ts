import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// GET /api/admin/users?page=&q=&scope=all|regular|system
// 默认 all：后台必须能看到全部会员行（含系统等级账号），不允许有任何行不可见
export async function GET(req: NextRequest) {
  const { ok } = await requirePerm(PERMISSIONS.USER_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
  const q = (searchParams.get("q") || "").trim();
  const pageSize = 30;
  const scopeRaw = searchParams.get("scope") || "all";
  const scope = scopeRaw === "regular" || scopeRaw === "system" ? scopeRaw : "all";

  const where: any = {
    ...(scope === "regular"
      ? { membership: { isSystem: false } }
      : scope === "system"
        ? { membership: { isSystem: true } }
        : {}),
    ...(q
      ? {
          OR: [
            { username: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { phone: { contains: q } },
            { nickname: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [list, total, grouped, totalAll, totalRegular, totalSystem] = await Promise.all([
    db.user.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        membership: { select: { code: true, name: true, isSystem: true } },
        _count: { select: { prompts: true, apiKeys: true } },
      },
    }),
    db.user.count({ where }),
    db.user.groupBy({ by: ["membershipLevel"], _count: { _all: true } }),
    db.user.count(),
    db.user.count({ where: { membership: { isSystem: false } } }),
    db.user.count({ where: { membership: { isSystem: true } } }),
  ]);

  // 各等级行数（含 0 行的等级），与 User 总行数应能对上
  const levelMeta = await db.membershipLevel.findMany({
    select: { code: true, name: true, isSystem: true, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
  });
  const countMap = new Map(grouped.map((g) => [g.membershipLevel, g._count._all]));
  const levelCounts = levelMeta.map((l) => ({ ...l, count: countMap.get(l.code) ?? 0 }));

  return NextResponse.json({
    list: list.map(({ passwordHash, ...rest }) => rest),
    total,
    page,
    pageSize,
    scope,
    levelCounts,
    scopeCounts: { all: totalAll, regular: totalRegular, system: totalSystem },
  });
}

const createSchema = z.object({
  username: z
    .string()
    .min(3, "账号至少 3 位")
    .max(20, "账号最多 20 位")
    .regex(/^[A-Za-z0-9_\-]+$/, "账号只能包含字母、数字、下划线、连字符"),
  password: z.string().min(6, "密码至少 6 位").max(72),
  nickname: z.string().max(20).optional().default(""),
  email: z.string().email("邮箱格式不正确").max(100).or(z.literal("")).optional(),
  phone: z
    .string()
    .regex(/^[0-9+\-\s]{6,20}$/, "手机号格式不正确")
    .or(z.literal(""))
    .optional(),
  status: z.enum(["active", "banned"]).optional().default("active"),
  allowPublish: z.boolean().optional().default(true),
});

// POST /api/admin/users  后台新建会员
export async function POST(req: NextRequest) {
  const { admin, ok } = await requirePerm(PERMISSIONS.USER_WRITE);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const d = parsed.data;
  const email = d.email?.trim() || null;
  const phone = d.phone?.trim() || null;

  const dupName = await db.user.findFirst({ where: { username: d.username } });
  if (dupName) return NextResponse.json({ error: "会员账号已存在" }, { status: 409 });
  const dupAdmin = await db.adminAccount.findUnique({ where: { username: d.username } });
  if (dupAdmin) return NextResponse.json({ error: "该账号名已被管理员占用" }, { status: 409 });
  if (email) {
    const dupEmail = await db.user.findUnique({ where: { email } });
    if (dupEmail) return NextResponse.json({ error: "邮箱已被其他账号使用" }, { status: 409 });
  }
  if (phone) {
    const dupPhone = await db.user.findUnique({ where: { phone } });
    if (dupPhone) return NextResponse.json({ error: "手机号已被其他账号使用" }, { status: 409 });
  }

  const ip = (await getClientIp()) || undefined;
  const u = await db.user.create({
    data: {
      username: d.username,
      passwordHash: await bcrypt.hash(d.password, 10),
      nickname: d.nickname || null,
      email,
      phone,
      status: d.status,
      allowPublish: d.allowPublish,
      registerIp: ip,
    },
  });

  await logAdminAction({
    adminId: admin!.id,
    action: "create",
    targetType: "user",
    targetId: u.id,
    detail: JSON.stringify({ username: u.username }),
    ip,
  });

  return NextResponse.json({ ok: true, id: u.id });
}
