import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

// ─── P6 群发批次记录：按 batchId 聚合（投递数 / 时间 / 主题） ───
// GET /api/admin/messages/batches?limit=
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const groups = await db.userMessage.groupBy({
    by: ["batchId"],
    where: { batchId: { not: null }, msgType: "notice" },
    _count: { _all: true },
    _min: { createdAt: true },
    orderBy: { _min: { createdAt: "desc" } },
    take: 20,
  });
  const batchIds = groups.map((g) => g.batchId!).filter(Boolean);
  // 每个批次取首条消息的标题/摘要（投递按同批同一内容创建，取任意一条即可）
  const samples = batchIds.length
    ? await db.userMessage.findMany({
        where: { batchId: { in: batchIds } },
        orderBy: { id: "asc" },
        select: { batchId: true, subject: true, body: true },
      })
    : [];
  const sampleOf = new Map<string, { subject: string | null; body: string }>();
  for (const s of samples) {
    if (s.batchId && !sampleOf.has(s.batchId)) sampleOf.set(s.batchId, { subject: s.subject, body: s.body });
  }

  return NextResponse.json({
    batches: groups.map((g) => {
      const sample = sampleOf.get(g.batchId!);
      return {
        batchId: g.batchId,
        count: g._count._all,
        subject: sample?.subject ?? null,
        // 标题为空时展示正文摘要
        preview: (sample?.body ?? "").slice(0, 80),
        sentAt: g._min.createdAt,
      };
    }),
  });
}
