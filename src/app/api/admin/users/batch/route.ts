import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { deleteMembers } from "@/lib/member-delete";
import { PERMISSIONS, requirePerm, requireSensitivePerm, reauthRequired, logAdminAction, getClientIp } from "@/lib/rbac";

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
      // 只作用于普通等级会员，避免误改系统账号
      const r = await db.user.updateMany({
        where: { id: { in: ids }, membership: { isSystem: false } },
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
        where: { id: { in: ids }, membership: { isSystem: false } },
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
        where: { id: { in: ids }, membership: { isSystem: false } },
        data: { commentBanned: value },
      });
      affected = r.count;
      break;
    }
    case "delete": {
      // 删号需更高权限（与单条删除一致），且需 10 分钟内二次密码验证
      const del = await requireSensitivePerm(PERMISSIONS.USER_DELETE);
      if (!del.ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
      if (del.needReauth) return reauthRequired();

      // 只删普通等级账号（系统账号跳过）；会员名下的提示词/技能/评论/产物与流水全部保留
      const targets = await db.user.findMany({
        where: { id: { in: ids }, membership: { isSystem: false } },
        select: { id: true },
      });
      const deletableIds = targets.map((t) => t.id);
      skipped = ids.length - deletableIds.length;

      if (deletableIds.length > 0) {
        affected = await deleteMembers(deletableIds);
      }
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
