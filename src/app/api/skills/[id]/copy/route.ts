import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// 复制 SKILL.md 计数 +1（原生 SQL 自增，不触 updatedAt，避免 Meili 重复推送）
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // 轻防抖：同 IP 每分钟最多 30 次复制计数
  if (!rateLimit(`skill-copy:${clientIp(req)}`, 30, 60_000)) {
    return NextResponse.json({ error: "too frequent" }, { status: 429 });
  }

  const { id } = await params;
  const sid = Number(id);
  if (!sid) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const rows = await db.$queryRaw<{ copy_count: number }[]>`
    UPDATE "Skill" SET copy_count = copy_count + 1
    WHERE id = ${sid} AND status = 'published'
    RETURNING copy_count`;
  if (!rows.length) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ copyCount: rows[0].copy_count });
}
