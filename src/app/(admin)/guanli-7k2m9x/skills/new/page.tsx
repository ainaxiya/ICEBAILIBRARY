import SkillForm, { type SkillFormData } from "@/components/admin/SkillForm";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "新增技能" };

export default async function AdminSkillNewPage() {
  const cats = await db.skillCategory.findMany({ orderBy: { sort: "asc" } });
  const initial: SkillFormData = {
    slug: "", name: "", summary: "", skillMd: "", files: [],
    categoryId: cats[0]?.id || 0, tags: [],
    author: "", sourceUrl: "", sourceSite: "", version: "", license: "",
    language: "zh", status: "published",
    viewCount: 0, copyCount: 0, downloadCount: 0, commentCount: 0,
    publishedAt: "",
  };
  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">新增技能</h1>
      <p className="mb-5 text-sm text-zinc-500">填写 SKILL.md 全文与元信息，保存后进入前台列表与搜索索引。</p>
      <SkillForm cats={cats} initial={initial} />
    </div>
  );
}
