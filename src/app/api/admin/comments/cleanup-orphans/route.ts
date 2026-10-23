import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// POST /api/admin/comments/cleanup-orphans
// 物理删除「无主评论」：目标对象（prompt/skill/software）已不存在的评论。
// 手动触发，不做自动清理（决策：孤儿评论永不自动删，由管理员确认后清理）。
export async function POST(req: NextRequest) {
  const { user: admin, ok } = await requirePerm(PERMISSIONS.COMMENT_MODERATE);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [promptIds, skillIds, softIds] = await Promise.all([
    db.prompt.findMany({ select: { id: true } }),
    db.skill.findMany({ select: { id: true } }),
    db.software.findMany({ select: { id: true } }),
  ]);
  const alive = {
    prompt: new Set(promptIds.map((r) => r.id)),
    skill: new Set(skillIds.map((r) => r.id)),
    software: new Set(softIds.map((r) => r.id)),
  };

  const orphans = await db.comment.findMany({
    select: { id: true, targetType: true, targetId: true },
  });
  const dead = orphans
    .filter((c) => {
      const set = alive[c.targetType as keyof typeof alive];
      return !set || !set.has(c.targetId);
    })
    .map((c) => c.id);

  if (!dead.length) return NextResponse.json({ ok: true, deleted: 0 });

  // 物理删除（含回复，外键级联由 schema 保证；若无级联则先删子后删父）
  await db.comment.deleteMany({ where: { parentId: { in: dead } } });
  const res = await db.comment.deleteMany({ where: { id: { in: dead } } });

  await logAdminAction({
    adminId: admin!.id,
    action: "delete",
    targetType: "comment",
    targetId: 0,
    detail: `清理无主评论 ${res.count} 条`,
    ip: await getClientIp(),
  });
  return NextResponse.json({ ok: true, deleted: res.count });
}
