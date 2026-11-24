import { db } from "@/lib/db";

// 删除会员（单条/批量共用）：
//   内容类（Prompt / Skill / Comment / GeneratedAsset）一律保留，作者由外键 SetNull 置空；
//   财务/流水类（credit_* / usage_record / pay_order / billing_reconcile / user_subscription / user_message）
//   一律保留记录，作者置空；
//   这里只清理会员私有的互动数据与 Key/任务，并同步冗余计数。
export async function deleteMembers(userIds: number[]): Promise<number> {
  if (userIds.length === 0) return 0;

  return db.$transaction(async (tx) => {
    // 先取互动冗余计数快照（删除后无法再 group）
    const [likeGroups, favoriteGroups, commentLikeGroups] = await Promise.all([
      tx.like.groupBy({ by: ["promptId"], where: { userId: { in: userIds } }, _count: { _all: true } }),
      tx.favorite.groupBy({ by: ["promptId"], where: { userId: { in: userIds } }, _count: { _all: true } }),
      tx.commentLike.groupBy({ by: ["commentId"], where: { userId: { in: userIds } }, _count: { _all: true } }),
    ]);

    // Key 额度预占表按 apiKeyId 关联，需随 Key 一起清理
    const keys = await tx.userApiKey.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const keyIds = keys.map((k) => k.id);

    await tx.like.deleteMany({ where: { userId: { in: userIds } } });
    await tx.favorite.deleteMany({ where: { userId: { in: userIds } } });
    await tx.commentLike.deleteMany({ where: { userId: { in: userIds } } });
    await tx.userFavorite.deleteMany({ where: { userId: { in: userIds } } });
    if (keyIds.length > 0) {
      await tx.apiKeyQuotaHold.deleteMany({ where: { apiKeyId: { in: keyIds } } });
    }
    await tx.userApiKey.deleteMany({ where: { userId: { in: userIds } } });
    await tx.videoTask.deleteMany({ where: { userId: { in: userIds } } });

    // 同步冗余计数（GREATEST 兜底，避免历史脏数据被减成负数）
    for (const g of likeGroups) {
      await tx.$executeRaw`UPDATE "Prompt" SET "likeCount" = GREATEST("likeCount" - ${g._count._all}, 0) WHERE id = ${g.promptId}`;
    }
    for (const g of favoriteGroups) {
      await tx.$executeRaw`UPDATE "Prompt" SET "favoriteCount" = GREATEST("favoriteCount" - ${g._count._all}, 0) WHERE id = ${g.promptId}`;
    }
    for (const g of commentLikeGroups) {
      await tx.$executeRaw`UPDATE "Comment" SET "likeCount" = GREATEST("likeCount" - ${g._count._all}, 0) WHERE id = ${g.commentId}`;
    }

    const r = await tx.user.deleteMany({ where: { id: { in: userIds } } });
    return r.count;
  });
}
