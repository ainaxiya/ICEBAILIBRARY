import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { getCategoryMeta } from "@/lib/category-meta";

export const dynamic = "force-dynamic";

// ─── 冰山实验场 M2：我的收藏（只读） ───
// 提示词收藏仍在 Favorite 旧表，技能收藏在 UserFavorite 通用表；
// 这里只读复用，不新增写入接口（收藏/取消收藏走既有 /api/user/favorites）。
// 返回内容供「一键带入对话」使用，因此提示词带上正文（截断到 8000 字，尽量保留完整分段）。

const CONTENT_LIMIT = 8000;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const [favRows, ufRows] = await Promise.all([
    db.favorite.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { promptId: true },
    }),
    db.userFavorite.findMany({
      where: { userId: user.id, targetType: "skill" },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { targetId: true },
    }),
  ]);

  const promptIds = favRows.map((r) => r.promptId);
  const skillIds = ufRows.map((r) => r.targetId);

  const [prompts, skills] = await Promise.all([
    promptIds.length
      ? db.prompt.findMany({
          // 收藏永久保留：不过滤 status，内容下架后收藏行仍可查看（用库里现存的值）
          where: { id: { in: promptIds } },
          select: { id: true, title: true, category: true, content: true, type: true },
        })
      : Promise.resolve([] as { id: number; title: string; category: string; content: string; type: string }[]),
    skillIds.length
      ? db.skill.findMany({
          // 收藏永久保留：不过滤 status
          where: { id: { in: skillIds } },
          select: { id: true, name: true, slug: true, summary: true, skillMd: true },
        })
      : Promise.resolve(
          [] as { id: number; name: string; slug: string; summary: string; skillMd: string }[]
        ),
  ]);

  // 按收藏时间倒序还原（数据库 in 查询不保证顺序）
  const pById = new Map(prompts.map((p) => [p.id, p]));
  const orderedPrompts = favRows
    .map((r) => pById.get(r.promptId))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => ({
      id: p.id,
      title: p.title,
      category: p.category ? getCategoryMeta(p.category)?.name.zh ?? p.category : null,
      content: p.content.slice(0, CONTENT_LIMIT),
      type: p.type,
    }));

  const sById = new Map(skills.map((s) => [s.id, s]));
  const orderedSkills = ufRows
    .map((r) => sById.get(r.targetId))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      summary: s.summary,
      // 技能没有独立的正文参数，带入对话时用 SKILL.md 摘要（截断避免超长）
      content: s.skillMd.slice(0, CONTENT_LIMIT),
    }));

  return NextResponse.json({ prompts: orderedPrompts, skills: orderedSkills });
}
