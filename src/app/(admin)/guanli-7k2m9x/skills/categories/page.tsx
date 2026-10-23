import SkillCategoryManager from "@/components/admin/SkillCategoryManager";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "技能分类" };

export default async function AdminSkillCategoriesPage() {
  const cats = await db.skillCategory.findMany({
    orderBy: { sort: "asc" },
    include: { _count: { select: { skills: true } } },
  });
  const initial = cats.map(({ _count, ...c }) => ({ ...c, skillCount: _count.skills }));
  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">技能分类</h1>
      <p className="mb-5 text-sm text-zinc-500">
        管理 AI 技能分类，slug 为 2 字母短码（前台 URL 使用，如 /skills?cat=bc）。
      </p>
      <SkillCategoryManager initial={initial} />
    </div>
  );
}
