import { db } from "@/lib/db";

// 评论挂载目标类型（v0.6 评论通用化；未来新栏目在此加值）
export const COMMENT_TARGET_TYPES = ["prompt", "skill", "software"] as const;
export type CommentTargetType = (typeof COMMENT_TARGET_TYPES)[number];

export function isCommentTargetType(v: string): v is CommentTargetType {
  return (COMMENT_TARGET_TYPES as readonly string[]).includes(v);
}

// 校验评论目标是否存在且可评论；返回 null=目标不存在
export async function getCommentTarget(targetType: string, targetId: number) {
  if (targetType === "prompt") {
    const p = await db.prompt.findUnique({
      where: { id: targetId },
      select: { id: true, status: true, commentsClosed: true },
    });
    return p ? { status: p.status, commentsClosed: p.commentsClosed } : null;
  }
  if (targetType === "skill") {
    const s = await db.skill.findUnique({
      where: { id: targetId },
      select: { id: true, status: true },
    });
    return s ? { status: s.status, commentsClosed: false } : null;
  }
  if (targetType === "software") {
    const s = await db.software.findUnique({
      where: { id: targetId },
      select: { id: true, status: true },
    });
    return s ? { status: s.status, commentsClosed: false } : null;
  }
  return null;
}

// 评论计数通用增减（在事务内调用；目标表必须存在 commentCount 列）
// 原生 SQL 自增：不触发 @updatedAt（前台评论不应改变内容更新时间的语义；后台编辑才更新）
export async function bumpCommentCount(
  tx: any,
  targetType: string,
  targetId: number,
  delta: 1 | -1
) {
  const table = targetType === "prompt" ? "Prompt" : targetType === "skill" ? "Skill" : "Software";
  const inc = delta > 0 ? 1 : -1;
  await tx.$executeRawUnsafe(
    `UPDATE "${table}" SET "commentCount" = "commentCount" + $1 WHERE id = $2`,
    inc,
    targetId
  );
}
