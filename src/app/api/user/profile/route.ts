import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/user/profile  当前用户资料
export async function GET() {
  const currentUser = await getCurrentUser();
  if (!currentUser) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const user = await db.user.findUnique({
    where: { id: currentUser.id },
    select: {
      id: true,
      username: true,
      email: true,
      phone: true,
      nickname: true,
      avatar: true,
      bio: true,
      wechat: true,
      qq: true,
      telegram: true,
      birthday: true,
      gender: true,
      nationality: true,
      role: true,
      membershipLevel: true,
      membershipUntil: true,
      status: true,
      createdAt: true,
    },
  });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(user);
}

// PUT /api/user/profile  更新当前用户资料
export async function PUT(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const data: any = {};

  if (typeof body?.nickname === "string") {
    const nickname = body.nickname.trim();
    if (nickname.length > 30) {
      return NextResponse.json({ error: "昵称过长（最多 30 字符）" }, { status: 400 });
    }
    data.nickname = nickname || null;
  }
  if (typeof body?.avatar === "string") {
    // avatar 通常是上传后返回的路径 /uploads/avatars/xxx.webp
    if (body.avatar.length > 500) {
      return NextResponse.json({ error: "avatar 路径过长" }, { status: 400 });
    }
    data.avatar = body.avatar || null;
  }
  if (typeof body?.bio === "string") {
    const bio = body.bio.trim();
    if (bio.length > 500) {
      return NextResponse.json({ error: "简介过长（最多 500 字符）" }, { status: 400 });
    }
    data.bio = bio || null;
  }
  // v0.92 #9 会员资料扩展：联系方式与个人档案
  const contactFields: [string, number][] = [
    ["wechat", 50],
    ["qq", 30],
    ["telegram", 50],
    ["nationality", 50],
  ];
  for (const [field, max] of contactFields) {
    if (typeof body?.[field] === "string") {
      const v = (body[field] as string).trim();
      if (v.length > max) {
        return NextResponse.json({ error: `${field} 过长（最多 ${max} 字符）` }, { status: 400 });
      }
      data[field] = v || null;
    }
  }
  // v0.92 #9 手机/邮箱可改（唯一性校验）
  if (typeof body?.email === "string") {
    const email = body.email.trim().toLowerCase();
    if (email.length > 100) {
      return NextResponse.json({ error: "邮箱过长（最多 100 字符）" }, { status: 400 });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
    }
    if (email) {
      const taken = await db.user.findFirst({
        where: { email, NOT: { id: currentUser.id } },
        select: { id: true },
      });
      if (taken) return NextResponse.json({ error: "该邮箱已被其他账号使用" }, { status: 409 });
    }
    data.email = email || null;
  }
  if (typeof body?.phone === "string") {
    const phone = body.phone.trim();
    if (phone.length > 20) {
      return NextResponse.json({ error: "手机号过长（最多 20 字符）" }, { status: 400 });
    }
    if (phone && !/^\+?[\d\s-]{5,20}$/.test(phone)) {
      return NextResponse.json({ error: "手机号格式不正确" }, { status: 400 });
    }
    if (phone) {
      const taken = await db.user.findFirst({
        where: { phone, NOT: { id: currentUser.id } },
        select: { id: true },
      });
      if (taken) return NextResponse.json({ error: "该手机号已被其他账号使用" }, { status: 409 });
    }
    data.phone = phone || null;
  }
  if (typeof body?.gender === "string") {
    const g = body.gender;
    if (g && !["male", "female", "other", "secret"].includes(g)) {
      return NextResponse.json({ error: "性别取值无效" }, { status: 400 });
    }
    data.gender = g || null;
  }
  if (body?.birthday !== undefined) {
    if (body.birthday === null || body.birthday === "") {
      data.birthday = null;
    } else {
      const d = new Date(body.birthday);
      if (Number.isNaN(d.getTime()) || d.getTime() > Date.now()) {
        return NextResponse.json({ error: "生日无效" }, { status: 400 });
      }
      data.birthday = d;
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "没有需要更新的字段" }, { status: 400 });
  }

  const updated = await db.user.update({
    where: { id: currentUser.id },
    data,
    select: {
      id: true,
      username: true,
      email: true,
      phone: true,
      nickname: true,
      avatar: true,
      bio: true,
      wechat: true,
      qq: true,
      telegram: true,
      birthday: true,
      gender: true,
      nationality: true,
    },
  });

  return NextResponse.json(updated);
}
