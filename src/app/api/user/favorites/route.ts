import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { getCategoryMeta } from "@/lib/category-meta";
import { skillHref } from "@/lib/skill-link";

export const dynamic = "force-dynamic";

// ─── v0.92 #9 通用收藏（prompt/skill/software）：提示词收藏数据仍在 Favorite 旧表，此处统一出入口 ───
// v0.117 会员中心收藏夹改版：?type=all 混合返回 提示词+技能（软件不再前台展示，POST toggle 仍兼容）

const TARGETS = ["prompt", "skill", "software"] as const;
type TargetType = (typeof TARGETS)[number];

// GET /api/user/favorites?type=prompt|skill|software|all  当前用户收藏列表（含目标摘要与下级分类）
export async function GET(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const type = req.nextUrl.searchParams.get("type") as TargetType | "all";
  if (!TARGETS.includes(type as TargetType) && type !== "all") {
    return NextResponse.json({ error: "type 仅支持 prompt/skill/software/all" }, { status: 400 });
  }

  // v0.114 单查模式：?targetId=N → { favorited, loggedIn }（未登录不 401，供匿名详情页按钮初始化）
  const qTargetId = Number(req.nextUrl.searchParams.get("targetId") || 0);
  if (type !== "all" && Number.isInteger(qTargetId) && qTargetId > 0) {
    const me = await getCurrentUser();
    if (!me) return NextResponse.json({ favorited: false, loggedIn: false });
    const favorited =
      type === "prompt"
        ? !!(await db.favorite.findUnique({
            where: { userId_promptId: { userId: me.id, promptId: qTargetId } },
            select: { userId: true },
          }))
        : !!(await db.userFavorite.findUnique({
            where: { userId_targetType_targetId: { userId: me.id, targetType: type, targetId: qTargetId } },
            select: { id: true },
          }));
    return NextResponse.json({ favorited, loggedIn: true });
  }

  // v0.117 混合模式：提示词 + 技能合并，按收藏时间倒序（软件不再前台展示）
  if (type === "all") {
    const [favRows, ufRows] = await Promise.all([
      db.favorite.findMany({
        where: { userId: currentUser.id },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { createdAt: true, promptId: true },
      }),
      db.userFavorite.findMany({
        where: { userId: currentUser.id, targetType: "skill" },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { createdAt: true, targetId: true },
      }),
    ]);

    const promptIds = favRows.map((r) => r.promptId);
    const skillIds = ufRows.map((r) => r.targetId);
    const [prompts, skills] = await Promise.all([
      promptIds.length
        ? db.prompt.findMany({
            where: { id: { in: promptIds }, status: "published" },
            select: { id: true, title: true, description: true, category: true },
          })
        : Promise.resolve([] as { id: number; title: string; description: string | null; category: string | null }[]),
      skillIds.length
        ? db.skill.findMany({
            where: { id: { in: skillIds }, status: "published" },
            select: { id: true, name: true, slug: true, summary: true, category: { select: { name: true } } },
          })
        : Promise.resolve([] as { id: number; name: string; slug: string; summary: string | null; category: { name: string } | null }[]),
    ]);

    type MixedItem = {
      id: number;
      targetId: number;
      createdAt: Date;
      title: string;
      href: string;
      summary: string | null;
      targetType: "prompt" | "skill";
      category: string | null;
    };
    const items: MixedItem[] = [];
    const pById = new Map(prompts.map((p) => [p.id, p]));
    for (const r of favRows) {
      const p = pById.get(r.promptId);
      if (!p) continue; // 已删除/下架的收藏不展示
      items.push({
        id: p.id,
        targetId: p.id,
        createdAt: r.createdAt,
        title: p.title,
        href: `/p/${p.id}`,
        summary: p.description,
        targetType: "prompt",
        category: p.category ? getCategoryMeta(p.category)?.name.zh ?? p.category : null,
      });
    }
    const sById = new Map(skills.map((s) => [s.id, s]));
    for (const r of ufRows) {
      const s = sById.get(r.targetId);
      if (!s) continue;
      items.push({
        id: s.id,
        targetId: s.id,
        createdAt: r.createdAt,
        title: s.name,
        href: skillHref(s.slug, s.id),
        summary: s.summary,
        targetType: "skill",
        category: s.category?.name ?? null,
      });
    }
    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return NextResponse.json({ items });
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
