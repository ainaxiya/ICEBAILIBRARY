import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// ─── P3 模型库批量操作：厂商 / Key / 模型 / 绑定 的启用·禁用·删除 ───
// POST /api/admin/models/batch
// { resource: "vendors"|"keys"|"models"|"bindings", action: "enable"|"disable"|"delete", ids: number[] }

const schema = z.object({
  resource: z.enum(["vendors", "keys", "models", "bindings"]),
  action: z.enum(["enable", "disable", "delete"]),
  ids: z.array(z.number().int().positive()).min(1).max(200),
});

// 各资源的审计 targetType（与单条路由保持一致）
const TARGET_TYPE = {
  vendors: "ai_vendor",
  keys: "vendor_api_key",
  models: "ai_model",
  bindings: "key_model_binding",
} as const;

// POST /api/admin/models/batch —— 批量启用/禁用/删除，返回 affected 数量
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_WRITE);
  if (!user || !ok) return NextResponse.json({ error: "no permission" }, { status: 403 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }
  const { resource, action, ids } = parsed.data;

  let affected = 0;

  if (action === "delete") {
    // 厂商删除会级联删除其 Key/模型/绑定（schema onDelete: Cascade），属预期行为
    if (resource === "vendors") {
      affected = (await db.aiVendor.deleteMany({ where: { id: { in: ids } } })).count;
    } else if (resource === "keys") {
      affected = (await db.vendorApiKey.deleteMany({ where: { id: { in: ids } } })).count;
    } else if (resource === "models") {
      affected = (await db.aiModel.deleteMany({ where: { id: { in: ids } } })).count;
    } else {
      affected = (await db.keyModelBinding.deleteMany({ where: { id: { in: ids } } })).count;
    }
  } else if (resource === "bindings") {
    // 绑定：enabled 布尔开关
    affected = (
      await db.keyModelBinding.updateMany({
        where: { id: { in: ids } },
        data: { enabled: action === "enable" },
      })
    ).count;
  } else if (resource === "keys") {
    // Key：status active/disabled
    affected = (
      await db.vendorApiKey.updateMany({
        where: { id: { in: ids } },
        data: { status: action === "enable" ? "active" : "disabled" },
      })
    ).count;
  } else if (resource === "vendors") {
    // 厂商：status online/offline
    affected = (
      await db.aiVendor.updateMany({
        where: { id: { in: ids } },
        data: { status: action === "enable" ? "online" : "offline" },
      })
    ).count;
  } else {
    // 模型：status online/offline
    affected = (
      await db.aiModel.updateMany({
        where: { id: { in: ids } },
        data: { status: action === "enable" ? "online" : "offline" },
      })
    ).count;
  }

  await logAdminAction({
    adminId: admin.id,
    action: action === "delete" ? "delete" : "update",
    targetType: TARGET_TYPE[resource],
    detail: JSON.stringify({ batch: true, resource, op: action, ids, affected }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, affected });
}
