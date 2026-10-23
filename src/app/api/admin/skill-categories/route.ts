import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePerm } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// 技能分类：slug 为 2 字母短码（与提示词分类 URL 风格一致）
const SLUG_RE = /^[a-z]{2}$/;

// 列表（含技能数量）
export async function GET() {
  const { ok } = await requirePerm("skill:manage");
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const rows = await db.skillCategory.findMany({
    orderBy: { sort: "asc" },
    include: { _count: { select: { skills: true } } },
  });
  return NextResponse.json(
    rows.map(({ _count, ...c }) => ({ ...c, skillCount: _count.skills }))
  );
}

// 新建
export async function POST(req: NextRequest) {
  const { ok } = await requirePerm("skill:manage");
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const name = (body?.name || "").trim();
  const nameEn = (body?.nameEn || "").trim();
  const slug = (body?.slug || "").trim().toLowerCase();
  const icon = (body?.icon || "").trim();
  if (!name) return NextResponse.json({ error: "名称不能为空" }, { status: 400 });
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: "短码必须为 2 个小写字母" }, { status: 400 });

  const exists = await db.skillCategory.findFirst({ where: { OR: [{ name }, { slug }] } });
  if (exists) return NextResponse.json({ error: "名称或短码已存在" }, { status: 409 });

  const maxSort = await db.skillCategory.aggregate({ _max: { sort: true } });
  const cat = await db.skillCategory.create({
    data: { name, nameEn: nameEn || name, slug, icon, sort: (maxSort._max.sort ?? -1) + 1 },
  });
  return NextResponse.json(cat);
}

// 批量排序
export async function PUT(req: NextRequest) {
  const { ok } = await requirePerm("skill:manage");
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const ids = body?.ids;
  if (!Array.isArray(ids)) return NextResponse.json({ error: "ids 必须为数组" }, { status: 400 });

  await db.$transaction(
    ids.map((id, i) => db.skillCategory.update({ where: { id: Number(id) }, data: { sort: i } }))
  );
  return NextResponse.json({ ok: true });
}
