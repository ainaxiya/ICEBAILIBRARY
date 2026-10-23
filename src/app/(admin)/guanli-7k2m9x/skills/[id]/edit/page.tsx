import SkillForm, { type SkillFormData } from "@/components/admin/SkillForm";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";
export const metadata = { title: "编辑技能" };

type FileEntry = { path: string; content: string };

export default async function AdminSkillEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const skill = await db.skill.findUnique({ where: { id: Number(id) } });
  if (!skill) notFound();
  const cats = await db.skillCategory.findMany({ orderBy: { sort: "asc" } });

  const files = (Array.isArray(skill.files) ? skill.files : []) as unknown as FileEntry[];
  const initial: SkillFormData = {
    id: skill.id,
    slug: skill.slug, name: skill.name, summary: skill.summary, skillMd: skill.skillMd,
    files: files.map((f) => ({ path: f.path, content: f.content })),
    categoryId: skill.categoryId, tags: skill.tags,
    author: skill.author || "", sourceUrl: skill.sourceUrl || "", sourceSite: skill.sourceSite || "",
    version: skill.version || "", license: skill.license || "",
    language: skill.language, status: skill.status,
    viewCount: skill.viewCount, copyCount: skill.copyCount, downloadCount: skill.downloadCount, commentCount: skill.commentCount,
    publishedAt: skill.publishedAt
      ? new Date(skill.publishedAt.getTime() - skill.publishedAt.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      : "",
  };
  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">编辑技能</h1>
      <p className="mb-5 text-sm text-zinc-500">修改后自动同步搜索索引；下线将从索引移除。</p>
      <SkillForm cats={cats} initial={initial} />
    </div>
  );
}
