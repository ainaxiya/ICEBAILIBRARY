import { describe, it, expect, afterAll } from "vitest";
import { db } from "@/lib/db";

// ─── 会员删除后评论保留（Comment.userId 可空 + onDelete: SetNull）───
// 覆盖：删掉发过评论的会员 → 评论仍可正常读取，作者为空（前台显示「该会员号已注销」）

let seq = 0;

afterAll(async () => {
  await db.$disconnect();
});

describe("会员删除后评论保留", () => {
  it("Comment.userId 外键为 SET NULL（不被数据库锁定）", async () => {
    const rows = await db.$queryRawUnsafe<{ confdeltype: string }[]>(
      `SELECT confdeltype FROM pg_constraint
       WHERE conrelid = '"Comment"'::regclass AND contype = 'f'
         AND pg_get_constraintdef(oid) LIKE '%"userId"%'`
    );
    // n = SET NULL
    expect(rows[0]?.confdeltype).toBe("n");
  });

  it("删掉发过评论的会员：评论仍存在、内容不变、作者为 null", async () => {
    const username = `unit-comment-del-${Date.now()}-${++seq}`;
    const user = await db.user.create({
      data: { username, passwordHash: "x", status: "active" },
    });
    const comment = await db.comment.create({
      data: {
        userId: user.id,
        targetType: "prompt",
        targetId: 999999,
        content: "这条评论要留下来",
      },
    });

    // 与后台删除接口同口径：只清指向 User 的点赞/收藏，评论不动（外键自动置空）
    await db.$transaction([
      db.like.deleteMany({ where: { userId: user.id } }),
      db.favorite.deleteMany({ where: { userId: user.id } }),
      db.commentLike.deleteMany({ where: { userId: user.id } }),
      db.user.delete({ where: { id: user.id } }),
    ]);

    const after = await db.comment.findUnique({
      where: { id: comment.id },
      include: { user: { select: { id: true } } },
    });
    expect(after).not.toBeNull();
    expect(after!.content).toBe("这条评论要留下来");
    expect(after!.status).toBe("published");
    expect(after!.userId).toBeNull();
    expect(after!.user).toBeNull();

    // 清理测试数据（评论无 target 外键，直接删）
    await db.comment.delete({ where: { id: comment.id } });
  });
});
