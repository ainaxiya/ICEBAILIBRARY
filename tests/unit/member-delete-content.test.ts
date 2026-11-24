import { describe, it, expect, afterAll } from "vitest";
import { db } from "@/lib/db";
import { deleteMembers } from "@/lib/member-delete";

// ─── 删会员不删内容（置空 + 已注销兜底）───
// 会员名下有提示词 / 技能 / 评论 / 产物 / 积分流水 / 点赞收藏时，
// 删除会员后：内容与流水全部保留且作者置空，互动数据清空，冗余计数同步正确。

let seq = 0;

afterAll(async () => {
  await db.$disconnect();
});

describe("删会员不级联删内容", () => {
  it("内容与流水保留、作者置空、互动清空、计数正确", async () => {
    const stamp = `${Date.now()}-${++seq}`;
    const username = `unit-member-del-${stamp}`;

    // 两个作者：被删会员 + 点赞的旁观者（验证计数只减 1、不误伤他人）
    const user = await db.user.create({ data: { username, passwordHash: "x", status: "active" } });
    const other = await db.user.create({
      data: { username: `${username}-other`, passwordHash: "x", status: "active" },
    });
    const category = await db.skillCategory.create({
      data: { name: `单元分类-${stamp}`, nameEn: `unit-cat-${stamp}`, slug: `uc${seq}` },
    });

    const prompt = await db.prompt.create({
      data: {
        userId: user.id,
        title: `单元提示词-${stamp}`,
        content: "内容要留下来",
        status: "published",
        likeCount: 2,
        favoriteCount: 2,
      },
    });
    const skill = await db.skill.create({
      data: {
        slug: `unit-skill-${stamp}`,
        name: `单元技能-${stamp}`,
        summary: "删除会员后技能保留",
        skillMd: "# skill",
        categoryId: category.id,
        userId: user.id,
        status: "published",
      },
    });
    const comment = await db.comment.create({
      data: {
        userId: user.id,
        targetType: "prompt",
        targetId: prompt.id,
        content: "这条评论要留下来",
        likeCount: 2,
      },
    });
    const asset = await db.generatedAsset.create({
      data: { userId: user.id, assetType: "image", storageKey: `unit/asset-${stamp}.png` },
    });
    const grant = await db.creditGrant.create({
      data: {
        userId: user.id,
        grantType: "gift",
        totalCredits: 100n,
        remainingCredits: 100n,
        sourceRef: `unit-gift-${stamp}`,
      },
    });
    const ledger = await db.creditLedger.create({
      data: {
        userId: user.id,
        changeAmount: 100n,
        balanceAfter: 100n,
        reason: "grant",
        requestId: `unit-ledger-${stamp}`,
      },
    });

    // 互动：被删会员点赞/收藏/评论点赞/通用收藏，旁观点赞同样计入计数
    await db.like.createMany({
      data: [
        { userId: user.id, promptId: prompt.id },
        { userId: other.id, promptId: prompt.id },
      ],
    });
    await db.favorite.createMany({
      data: [
        { userId: user.id, promptId: prompt.id },
        { userId: other.id, promptId: prompt.id },
      ],
    });
    await db.commentLike.createMany({
      data: [
        { userId: user.id, commentId: comment.id },
        { userId: other.id, commentId: comment.id },
      ],
    });
    await db.userFavorite.create({
      data: { userId: user.id, targetType: "skill", targetId: skill.id },
    });

    const removed = await deleteMembers([user.id]);
    expect(removed).toBe(1);

    // 会员已删
    expect(await db.user.findUnique({ where: { id: user.id } })).toBeNull();

    // 内容全在、作者置空
    const p2 = await db.prompt.findUnique({ where: { id: prompt.id } });
    expect(p2).not.toBeNull();
    expect(p2!.content).toBe("内容要留下来");
    expect(p2!.userId).toBeNull();

    const s2 = await db.skill.findUnique({ where: { id: skill.id } });
    expect(s2).not.toBeNull();
    expect(s2!.userId).toBeNull();

    const c2 = await db.comment.findUnique({ where: { id: comment.id } });
    expect(c2).not.toBeNull();
    expect(c2!.content).toBe("这条评论要留下来");
    expect(c2!.userId).toBeNull();

    const a2 = await db.generatedAsset.findUnique({ where: { id: asset.id } });
    expect(a2).not.toBeNull();
    expect(a2!.userId).toBeNull();

    // 流水保留、作者置空
    const g2 = await db.creditGrant.findUnique({ where: { id: grant.id } });
    expect(g2).not.toBeNull();
    expect(g2!.userId).toBeNull();
    expect(g2!.remainingCredits).toBe(100n);

    const l2 = await db.creditLedger.findUnique({ where: { id: ledger.id } });
    expect(l2).not.toBeNull();
    expect(l2!.userId).toBeNull();

    // 互动清空（只清被删会员，旁观点赞保留）
    expect(await db.like.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.favorite.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.commentLike.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.userFavorite.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.like.count({ where: { userId: other.id } })).toBe(1);

    // 冗余计数：各自只减 1（剩余旁观点赞/收藏/评论点赞）
    expect(p2!.likeCount).toBe(1);
    expect(p2!.favoriteCount).toBe(1);
    expect(c2!.likeCount).toBe(1);
    expect(
      await db.$queryRawUnsafe<{ likeCount: number }[]>(
        `SELECT "likeCount" FROM "Comment" WHERE id = ${comment.id}`
      )
    ).toEqual([{ likeCount: 1 }]);

    // 清理测试数据
    await db.commentLike.deleteMany({ where: { commentId: comment.id } });
    await db.like.deleteMany({ where: { promptId: prompt.id } });
    await db.favorite.deleteMany({ where: { promptId: prompt.id } });
    await db.comment.delete({ where: { id: comment.id } });
    await db.skill.delete({ where: { id: skill.id } });
    await db.prompt.delete({ where: { id: prompt.id } });
    await db.generatedAsset.delete({ where: { id: asset.id } });
    await db.creditGrant.delete({ where: { id: grant.id } });
    await db.creditLedger.delete({ where: { id: ledger.id } });
    await db.skillCategory.delete({ where: { id: category.id } });
    await db.user.delete({ where: { id: other.id } });
  });
});
