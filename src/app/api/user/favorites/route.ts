import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// ─── v0.92 #9 通用收藏（prompt/skill/software）：提示词收藏数据仍在 Favorite 旧表，此处统一出入口 ───

const TARGETS = ["prompt", "skill", "software"] as const;
type TargetType = (typeof TARGETS)[number];

// GET /api/user/favorites?type=prompt|skill|software  当前用户收藏列表（含目标摘要）
export async function GET(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const type = req.nextUrl.searchParams.get("type") as TargetType;
  if (!TARGETS.includes(type)) {
    return NextResponse.json({ error: "type 仅支持 prompt/skill/software" }, { status: 400 });
  }

  // 提示词收藏在 Favorite 旧表，技能/软件在 UserFavorite 通用表
  const rows =
    type === "prompt"
      ? await db.favorite.findMany({
          where: { userId: currentUser.id },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true, promptId: true },
        }).then((rs) => rs.map((r) => ({ id: r.promptId, targetId: r.promptId, createdAt: r.createdAt })))
      : await db.userFavorite.findMany({
          where: { userId: currentUser.id, targetType: type },
          orderBy: { createdAt: "desc" },
        });

  const ids = rows.map((r) => r.targetId);
  const items: { id: number; targetId: number; createdAt: Date; title: string; href: string; summary: string | null }[] = [];

  if (type === "prompt") {
    const prompts = await db.prompt.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, description: true },
    });
    const byId = new Map(prompts.map((p) => [p.id, p]));
    for (const r of rows) {
      const p = byId.get(r.targetId);
      if (!p) continue;
      items.push({
        id: r.id,
        targetId: r.targetId,
        createdAt: r.createdAt,
        title: p.title,
        href: `/p/${p.id}`,
        summary: p.description,
      });
    }
  } else if (type === "skill") {
    const skills = await db.skill.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, slug: true, summary: true },
    });
    const byId = new Map(skills.map((s) => [s.id, s]));
    for (const r of rows) {
      const s = byId.get(r.targetId);
      if (!s) continue;
      items.push({
        id: r.id,
        targetId: r.targetId,
        createdAt: r.createdAt,
        title: s.name,
        href: `/skills/${s.slug}-${s.id}`,
        summary: s.summary,
      });
    }
  } else {
    const softs = await db.software.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, slug: true, tagline: true },
    });
    const byId = new Map(softs.map((s) => [s.id, s]));
    for (const r of rows) {
      const s = byId.get(r.targetId);
      if (!s) continue;
      items.push({
        id: r.id,
        targetId: r.targetId,
        createdAt: r.createdAt,
        title: s.name,
        href: `/software/${s.slug}-${s.id}`,
        summary: s.tagline,
      });
    }
  }

  return NextResponse.json({ items });
}

// POST /api/user/favorites  { type, targetId } 切换收藏（已收藏则取消）
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const type = body?.type as TargetType;
  const targetId = Number(body?.targetId);
  if (!TARGETS.includes(type) || !Number.isInteger(targetId) || targetId <= 0) {
    return NextResponse.json({ error: "参数无效" }, { status: 400 });
  }

  // 校验目标存在
  const exists =
    type === "prompt"
      ? await db.prompt.findUnique({ where: { id: targetId }, select: { id: true } })
      : type === "skill"
        ? await db.skill.findUnique({ where: { id: targetId }, select: { id: true } })
        : await db.software.findUnique({ where: { id: targetId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "目标不存在" }, { status: 404 });

  // 提示词走 Favorite 旧表，技能/软件走 UserFavorite 通用表
  if (type === "prompt") {
    const key = { userId_promptId: { userId: currentUser.id, promptId: targetId } };
    const existing = await db.favorite.findUnique({ where: key });
    if (existing) {
      await db.favorite.delete({ where: key });
      return NextResponse.json({ favorited: false });
    }
    await db.favorite.create({ data: { userId: currentUser.id, promptId: targetId } });
    return NextResponse.json({ favorited: true });
  }

  const key = { userId_targetType_targetId: { userId: currentUser.id, targetType: type, targetId } };
  const existing = await db.userFavorite.findUnique({ where: key });
  if (existing) {
    await db.userFavorite.delete({ where: key });
    return NextResponse.json({ favorited: false });
  }
  await db.userFavorite.create({ data: { userId: currentUser.id, targetType: type, targetId } });
  return NextResponse.json({ favorited: true });
}
