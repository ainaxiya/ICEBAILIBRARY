import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PERMISSIONS, requirePerm } from "@/lib/rbac";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;
const VALID_STATUS = ["published", "hidden", "deleted"];

// GET /api/admin/comments?status=&q=&targetType=&targetId=&userId=&page= （兼容旧参数 promptId=）
export async function GET(req: NextRequest) {
  const { ok } = await requirePerm(PERMISSIONS.COMMENT_READ);
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || "";
  const q = (searchParams.get("q") || "").trim();
  const targetType = searchParams.get("targetType") || "";
  const targetId = Number(searchParams.get("targetId") || searchParams.get("promptId") || 0);
  const userId = Number(searchParams.get("userId") || 0);
  const page = Math.max(1, Number(searchParams.get("page") || 1) || 1);

  const where: any = {};
  if (status && VALID_STATUS.includes(status)) where.status = status;
  if (q) where.content = { contains: q, mode: "insensitive" };
  if (targetType) where.targetType = targetType;
  if (targetId) where.targetId = targetId;
  if (userId) where.userId = userId;

  const [rows, total, counts] = await Promise.all([
    db.comment.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        user: { select: { id: true, username: true, nickname: true, commentBanned: true } },
      },
    }),
    db.comment.count({ where }),
    db.comment.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  // 通用评论无硬外键：按目标类型批量补标题（orphan 目标显示为 null）
  const promptIds = [...new Set(rows.filter((c) => c.targetType === "prompt").map((c) => c.targetId))];
  const prompts = promptIds.length
    ? await db.prompt.findMany({ where: { id: { in: promptIds } }, select: { id: true, title: true } })
    : [];
  const titleMap = new Map(prompts.map((p) => [p.id, p.title]));
  const list = rows.map((c) => ({
    ...c,
    prompt:
      c.targetType === "prompt"
        ? { id: c.targetId, title: titleMap.get(c.targetId) ?? null }
        : null,
  }));

  return NextResponse.json({
    list,
    total,
    page,
    pageSize: PAGE_SIZE,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
  });
}
