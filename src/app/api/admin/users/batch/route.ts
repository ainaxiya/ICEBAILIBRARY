import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

const batchSchema = z.object({
  // status=批量改账户状态 allowPublish=发布权限 commentBanned=评论禁言 delete=批量删号
  action: z.enum(["status", "allowPublish", "commentBanned", "delete"]),
  value: z.union([z.boolean(), z.string()]).optional(),
  ids: z.array(z.number().int().positive()).min(1, "请至少选择一个会员").max(200, "一次最多操作 200 个"),
});

// POST /api/admin/users/batch — 会员批量操作
export async function POST(req: NextRequest) {
  const { admin, ok } = await requirePerm(PERMISSIONS.USER_WRITE);
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = batchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { action, value, ids } = parsed.data;

  let affected = 0;
  let skipped: number | undefined;

  switch (action) {
    case "status": {
      if (value !== "active" && value !== "banned") {
        return NextResponse.json({ error: "value 必须为 active 或 banned" }, { status: 400 });
      }
      // 只作用于前台会员，避免误改管理员账号
      const r = await db.user.updateMany({
        where: { id: { in: ids }, role: "user" },
        data: { status: value },
      });
      affected = r.count;
      break;
    }
    case "allowPublish": {
      if (typeof value !== "boolean") {
        return NextResponse.json({ error: "value 必须为布尔值" }, { status: 400 });
      }
      const r = await db.user.updateMany({
        where: { id: { in: ids }, role: "user" },
        data: { allowPublish: value },
      });
      affected = r.count;
      break;
    }
    case "commentBanned": {
      if (typeof value !== "boolean") {
        return NextResponse.json({ error: "value 必须为布尔值" }, { status: 400 });
      }
      const r = await db.user.updateMany({
        where: { id: { in: ids }, role: "user" },
        data: { commentBanned: value },
      });
      affected = r.count;
      break;
    }
    case "delete": {
      // 删号需更高权限（与单条删除一致）
      const del = await requirePerm(PERMISSIONS.USER_DELETE);
      if (!del.ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

      // 只删 role="user" 且名下 0 条提示词的账号，其余（有提示词/非会员）跳过
      const targets = await db.user.findMany({
        where: { id: { in: ids }, role: "user" },
        select: { id: true, _count: { select: { prompts: true } } },
      });
      const deletableIds = targets.filter((t) => t._count.prompts === 0).map((t) => t.id);
      skipped = ids.length - deletableIds.length;

      if (deletableIds.length > 0) {
        // 无内容后清理互动数据再删号（评论点赞外键指向 User，须先清），与单条删除事务一致
        await db.$transaction([
          db.like.deleteMany({ where: { userId: { in: deletableIds } } }),
          db.favorite.deleteMany({ where: { userId: { in: deletableIds } } }),
          db.commentLike.deleteMany({ where: { userId: { in: deletableIds } } }),
          db.comment.deleteMany({ where: { userId: { in: deletableIds } } }),
          db.user.deleteMany({ where: { id: { in: deletableIds } } }),
        ]);
      }
      affected = deletableIds.length;
      break;
    }
  }

  // 每种 action 记一条审计（detail 含 ids 数量）
  await logAdminAction({
    adminId: admin.id,
    action: action === "delete" ? "delete" : "batch_update",
    targetType: "user",
    detail: JSON.stringify({ action, idsCount: ids.length, affected, skipped }),
    ip: (await getClientIp()) || undefined,
  });

  return NextResponse.json({
    ok: true,
    affected,
    ...(skipped !== undefined ? { skipped } : {}),
  });
}
