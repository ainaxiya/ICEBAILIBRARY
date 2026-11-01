import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// ─── 积分包批量操作：上架 / 下架 / 删除 ───

const schema = z.object({
  action: z.enum(["activate", "deactivate", "delete"]),
  ids: z.array(z.number().int().positive()).min(1, "请至少选择一项").max(200, "单次最多操作 200 项"),
});

// POST /api/admin/credits/packs/batch
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.SETTING_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { action, ids } = parsed.data;

  let count = 0;
  if (action === "delete") {
    // 有支付单关联会被外键挡住，Prisma 报错时返回友好提示
    try {
      const r = await db.creditPack.deleteMany({ where: { id: { in: ids } } });
      count = r.count;
    } catch {
      return NextResponse.json({ error: "已被订单引用，无法删除" }, { status: 400 });
    }
  } else {
    const r = await db.creditPack.updateMany({
      where: { id: { in: ids } },
      data: { isActive: action === "activate" },
    });
    count = r.count;
  }

  await logAdminAction({
    adminId: admin.id,
    action: action === "delete" ? "delete" : "update",
    targetType: "setting",
    detail: JSON.stringify({ section: "credit_pack_batch", action, ids, count }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, count });
}
