import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePerm } from "@/lib/rbac";

export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z]{2}$/;

// 更新分类
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { ok } = await requirePerm("skill:manage");
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const cat = await db.skillCategory.findUnique({ where: { id: Number(id) } });
  if (!cat) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const name = (body?.name || "").trim();
  const nameEn = (body?.nameEn || "").trim();
  const slug = (body?.slug || "").trim().toLowerCase();
  const icon = (body?.icon || "").trim();
  // 自定义栏目描述与关键字（SEO）
  const metaDescription = typeof body?.metaDescription === "string" ? body.metaDescription.trim().slice(0, 500) : null;
  const metaKeywords = typeof body?.metaKeywords === "string" ? body.metaKeywords.trim().slice(0, 300) : null;
  if (!name) return NextResponse.json({ error: "名称不能为空" }, { status: 400 });
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: "短码必须为 2 个小写字母" }, { status: 400 });

  const dup = await db.skillCategory.findFirst({
    where: { OR: [{ name }, { slug }], NOT: { id: cat.id } },
  });
  if (dup) return NextResponse.json({ error: "名称或短码已存在" }, { status: 409 });

  await db.skillCategory.update({
    where: { id: cat.id },
    data: { name, nameEn: nameEn || name, slug, icon, metaDescription, metaKeywords },
  });
  return NextResponse.json({ ok: true });
}

// 删除（分类下有技能时拒绝）
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { ok } = await requirePerm("skill:manage");
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await params;
  const cat = await db.skillCategory.findUnique({ where: { id: Number(id) } });
  if (!cat) return NextResponse.json({ error: "not found" }, { status: 404 });

  const count = await db.skill.count({ where: { categoryId: cat.id } });
  if (count > 0) {
    return NextResponse.json({ error: `该分类下还有 ${count} 条技能，请先迁移或删除后再操作` }, { status: 409 });
  }

  await db.skillCategory.delete({ where: { id: cat.id } });
  return NextResponse.json({ ok: true });
}
