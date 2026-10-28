import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { syncSoftwareToMeili, removeSoftwareFromMeili } from "@/lib/meili";
import { requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

const batchSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
  action: z.enum(["publish", "unpublish", "delete"]),
});

// POST /api/admin/software/batch — 批量操作（对齐提示词批量）
export async function POST(req: NextRequest) {
  const { admin, ok } = await requirePerm("software:manage");
  if (!ok || !admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = batchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "参数错误" }, { status: 400 });
  }

  const { ids, action } = parsed.data;
  let affected = 0;

  switch (action) {
    case "publish": {
      // 发布时间只在首次发布时写入，已发布过的保留原时间
      await db.software.updateMany({
        where: { id: { in: ids }, publishedAt: null },
        data: { publishedAt: new Date() },
      });
      const r = await db.software.updateMany({
        where: { id: { in: ids } },
        data: { status: "published" },
      });
      affected = r.count;
      const published = await db.software.findMany({
        where: { id: { in: ids }, status: "published" },
        include: { category: { select: { slug: true } } },
      });
      await Promise.all(
        published.map((s) =>
          syncSoftwareToMeili({ ...s, categorySlug: s.category.slug }).catch(() => {})
        )
      );
      break;
    }
    case "unpublish": {
      const r = await db.software.updateMany({
        where: { id: { in: ids } },
        data: { status: "pending" },
      });
      affected = r.count;
      await Promise.all(ids.map((id) => removeSoftwareFromMeili(id).catch(() => {})));
      break;
    }
    case "delete": {
      const r = await db.software.deleteMany({ where: { id: { in: ids } } });
      affected = r.count;
      await Promise.all(ids.map((id) => removeSoftwareFromMeili(id).catch(() => {})));
      break;
    }
  }

  await logAdminAction({
    adminId: admin.id,
    action: "batch_update",
    targetType: "software",
    detail: JSON.stringify({ action, ids, affected }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, affected, action });
}
