import SoftwareCategoryManager from "@/components/admin/SoftwareCategoryManager";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "软件分类" };

export default async function AdminSoftwareCategoriesPage() {
  const cats = await db.softwareCategory.findMany({
    orderBy: { sort: "asc" },
    include: { _count: { select: { software: true } } },
  });
  const initial = cats.map(({ _count, ...c }) => ({ ...c, softCount: _count.software }));
  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">软件分类</h1>
      <p className="mb-5 text-sm text-zinc-500">
        管理 AI 软件分类，slug 为 2 字母短码（前台 URL 使用，如 /software?cat=to）。
      </p>
      <SoftwareCategoryManager initial={initial} />
    </div>
  );
}
