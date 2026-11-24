import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { deleteMembers } from "@/lib/member-delete";
import { diffFields, withChanges, type AuditChange } from "@/lib/audit-diff";
import { PERMISSIONS, requirePerm, requireSensitivePerm, reauthRequired, logAdminAction, getClientIp } from "@/lib/rbac";
import {
  normalizeLocaleField,
  normalizeRegion,
  normalizeTimezone,
  normalizeWebsiteField,
} from "@/lib/profile-fields";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  nickname: z.string().max(20).optional(),
  email: z.string().email("邮箱格式不正确").max(100).or(z.literal("")).optional(),
  phone: z
    .string()
    .regex(/^[0-9+\-\s]{6,20}$/, "手机号格式不正确")
    .or(z.literal(""))
    .optional(),
  // 头像：允许 http(s) 外链或本站 /uploads 相对路径（后台上传返回相对路径）
  avatar: z
    .string()
    .max(500)
    .refine((v) => v === "" || /^(https?:\/\/|\/)/.test(v), "头像地址不合法")
    .optional(),
  bio: z.string().max(500).optional(),
  // v0.96 会员资料扩展字段（与前台会员中心资料修改对齐）
  wechat: z.string().max(50).or(z.literal("")).optional(),
  qq: z.string().max(30).or(z.literal("")).optional(),
  telegram: z.string().max(50).or(z.literal("")).optional(),
  birthday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "生日格式不正确（YYYY-MM-DD）")
    .or(z.literal(""))
    .optional(),
  gender: z.enum(["male", "female", "other", "secret", ""]).optional(),
  nationality: z.string().max(50).or(z.literal("")).optional(),
  // v1.0.5 地区分列 + 地址/邮编/网站/语言/时区（与前台资料页同一套口径）
  countryCode: z.string().regex(/^[A-Za-z]{2}$/, "国家/地区代码应为两位 ISO2").or(z.literal("")).optional(),
  province: z.string().max(50).optional(),
  city: z.string().max(50).optional(),
  district: z.string().max(50).optional(),
  address: z.string().max(200).optional(),
  postalCode: z.string().max(20).optional(),
  website: z.string().max(200).optional(),
  locale: z.string().max(20).optional(),
  timezone: z.string().max(64).optional(),
  status: z.enum(["active", "banned"]).optional(),
  allowPublish: z.boolean().optional(),
  // 评论禁言/解除（独立于登录封禁）
  commentBanned: z.boolean().optional(),
  // 等级：只允许普通等级（接口内校验 isSystem / isActive）
  membershipLevel: z.string().min(1).max(50).optional(),
  newPassword: z.string().min(6, "新密码至少 6 位").max(72).optional(),
});

// 审计日志「变更前后」字段（账号/密码哈希等敏感字段不入日志）
const USER_AUDIT_FIELDS = [
  "nickname",
  "email",
  "phone",
  "avatar",
  "bio",
  "wechat",
  "qq",
  "telegram",
  "birthday",
  "gender",
  "nationality",
  "countryCode",
  "province",
  "city",
  "district",
  "address",
  "postalCode",
  "website",
  "locale",
  "timezone",
  "status",
  "allowPublish",
  "commentBanned",
  "membershipLevel",
] as const;
const USER_FIELD_LABELS: Record<string, string> = {
  nickname: "昵称",
  email: "邮箱",
  phone: "手机号",
  avatar: "头像",
  bio: "简介",
  wechat: "微信",
  qq: "QQ",
  telegram: "Telegram",
  birthday: "生日",
  gender: "性别",
  nationality: "国家/地区",
  countryCode: "国家代码",
  province: "省",
  city: "市",
  district: "区县",
  address: "地址",
  postalCode: "邮编",
  website: "网站",
  locale: "语言",
  timezone: "时区",
  status: "状态",
  allowPublish: "投稿权限",
  commentBanned: "评论禁言",
  membershipLevel: "等级",
};

// GET /api/admin/users/:id  会员详情（与列表行同结构，供独立详情页使用）
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { ok } = await requirePerm(PERMISSIONS.USER_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const uid = parseInt(id, 10);
  if (!Number.isInteger(uid) || uid <= 0) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const u = await db.user.findUnique({
    where: { id: uid },
    include: {
      membership: { select: { code: true, name: true, isSystem: true } },
      _count: { select: { prompts: true, apiKeys: true } },
    },
  });
  if (!u) return NextResponse.json({ error: "会员不存在" }, { status: 404 });

  const { passwordHash: _passwordHash, ...rest } = u;
  return NextResponse.json({ user: rest });
}

// PATCH /api/admin/users/:id  会员全字段修改 / 重置密码（账号不可改）
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { admin, ok } = await requirePerm(PERMISSIONS.USER_WRITE);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const uid = parseInt(id);
  const target = await db.user.findUnique({
    where: { id: uid },
    include: { membership: { select: { isSystem: true } } },
  });
  if (!target || target.membership?.isSystem) {
    return NextResponse.json({ error: "会员不存在" }, { status: 404 });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const d = parsed.data;

  const email = d.email !== undefined ? d.email.trim() || null : undefined;
  const phone = d.phone !== undefined ? d.phone.trim() || null : undefined;

  // 唯一性校验（排除自己）
  if (email) {
    const dup = await db.user.findFirst({ where: { email, NOT: { id: uid } } });
    if (dup) return NextResponse.json({ error: "邮箱已被其他账号使用" }, { status: 409 });
  }
  if (phone) {
    const dup = await db.user.findFirst({ where: { phone, NOT: { id: uid } } });
    if (dup) return NextResponse.json({ error: "手机号已被其他账号使用" }, { status: 409 });
  }

  const data: Record<string, unknown> = {};
  if (d.nickname !== undefined) data.nickname = d.nickname.trim() || null;
  if (email !== undefined) data.email = email;
  if (phone !== undefined) data.phone = phone;
  if (d.avatar !== undefined) data.avatar = d.avatar || null;
  if (d.bio !== undefined) data.bio = d.bio.trim() || null;
  if (d.wechat !== undefined) data.wechat = d.wechat.trim() || null;
  if (d.qq !== undefined) data.qq = d.qq.trim() || null;
  if (d.telegram !== undefined) data.telegram = d.telegram.trim() || null;
  if (d.birthday !== undefined) data.birthday = d.birthday ? new Date(d.birthday) : null;
  if (d.gender !== undefined) data.gender = d.gender || null;
  if (d.nationality !== undefined) data.nationality = d.nationality.trim() || null;

  // 地区四列：只要提交任一地区字段就走共用规范化（会顺带重算 nationality）
  if (
    d.countryCode !== undefined ||
    d.province !== undefined ||
    d.city !== undefined ||
    d.district !== undefined
  ) {
    const region = normalizeRegion({
      countryCode: d.countryCode,
      province: d.province,
      city: d.city,
      district: d.district,
    });
    if (region.error) return NextResponse.json({ error: region.error }, { status: 400 });
    Object.assign(data, region.data);
  }
  if (d.address !== undefined) data.address = d.address.trim() || null;
  if (d.postalCode !== undefined) data.postalCode = d.postalCode.trim() || null;
  if (d.website !== undefined) {
    const r = normalizeWebsiteField(d.website);
    if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
    data.website = r.value ?? null;
  }
  if (d.locale !== undefined) {
    const r = normalizeLocaleField(d.locale);
    if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
    data.locale = r.value ?? null;
  }
  if (d.timezone !== undefined) {
    const r = normalizeTimezone(d.timezone);
    if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
    data.timezone = r.value ?? null;
  }
  if (d.status !== undefined) data.status = d.status;
  if (d.allowPublish !== undefined) data.allowPublish = d.allowPublish;
  if (d.commentBanned !== undefined) data.commentBanned = d.commentBanned;
  if (d.membershipLevel !== undefined) {
    const level = await db.membershipLevel.findUnique({ where: { code: d.membershipLevel } });
    if (!level || level.isSystem) {
      return NextResponse.json({ error: "只能调整为普通等级" }, { status: 400 });
    }
    if (!level.isActive) {
      return NextResponse.json({ error: "该等级已停用，请先在等级管理中启用" }, { status: 400 });
    }
    data.membershipLevel = d.membershipLevel;
  }
  if (d.newPassword) data.passwordHash = await bcrypt.hash(d.newPassword, 10);

  const u = await db.user.update({ where: { id: uid }, data });
  // 变更前后差异：只记录白名单字段；密码仅记录「已重置」，不写哈希
  const changes: AuditChange[] = diffFields(
    target as unknown as Record<string, unknown>,
    { ...(target as unknown as Record<string, unknown>), ...data },
    USER_AUDIT_FIELDS,
    USER_FIELD_LABELS
  );
  if (d.newPassword) changes.push({ field: "password", label: "密码", before: null, after: "已重置" });
  await logAdminAction({
    adminId: admin!.id,
    action: "update",
    targetType: "user",
    targetId: uid,
    detail: withChanges({ fields: Object.keys(d), resetPassword: !!d.newPassword }, changes),
    ip: (await getClientIp()) || undefined,
  });

  return NextResponse.json({
    ok: true,
    status: u.status,
    allowPublish: u.allowPublish,
    nickname: u.nickname,
    email: u.email,
    phone: u.phone,
    membershipLevel: u.membershipLevel,
  });
}

// DELETE /api/admin/users/:id  删除会员
// 只删会员本身：其提示词/技能/评论/产物与财务流水全部保留（作者外键置空），
// 同一事务内清理点赞/收藏/评论点赞/通用收藏 + API Key/视频任务，并同步冗余计数。
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // 删除会员属敏感操作：除 user:delete 外还要求 10 分钟内二次密码验证
  const { admin, ok, needReauth } = await requireSensitivePerm(PERMISSIONS.USER_DELETE);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (admin && needReauth) return reauthRequired();

  const { id } = await ctx.params;
  const uid = parseInt(id);
  const target = await db.user.findUnique({
    where: { id: uid },
    include: { membership: { select: { isSystem: true } } },
  });
  if (!target || target.membership?.isSystem) {
    return NextResponse.json({ error: "会员不存在" }, { status: 404 });
  }

  await deleteMembers([uid]);

  await logAdminAction({
    adminId: admin!.id,
    action: "delete",
    targetType: "user",
    targetId: uid,
    detail: JSON.stringify({ username: target.username }),
    ip: (await getClientIp()) || undefined,
  });
  return NextResponse.json({ ok: true });
}
