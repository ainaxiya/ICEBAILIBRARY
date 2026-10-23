import SoftwareForm, { type SoftwareFormData } from "@/components/admin/SoftwareForm";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";
export const metadata = { title: "编辑软件" };

export default async function AdminSoftwareEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const soft = await db.software.findUnique({
    where: { id: Number(id) },
    include: { downloads: { orderBy: [{ sort: "asc" }, { id: "asc" }] } },
  });
  if (!soft) notFound();
  const [cats, buckets] = await Promise.all([
    db.softwareCategory.findMany({ orderBy: { sort: "asc" } }),
    db.storageBucket.findMany({ where: { enabled: true }, select: { id: true, name: true, isDefault: true }, orderBy: { id: "asc" } }),
  ]);

  const initial: SoftwareFormData = {
    id: soft.id,
    slug: soft.slug, name: soft.name, version: soft.version || "",
    tagline: soft.tagline || "", description: soft.description,
    icon: soft.icon || "", categoryId: soft.categoryId, tags: soft.tags,
    sizeText: soft.sizeText || "", platform: soft.platform || "",
    language: soft.language || "", officialUrl: soft.officialUrl || "",
    status: soft.status,
    viewCount: soft.viewCount, downloadCount: soft.downloadCount, commentCount: soft.commentCount,
    publishedAt: soft.publishedAt
      ? new Date(soft.publishedAt.getTime() - soft.publishedAt.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      : "",
    downloads: soft.downloads.map((d) => ({
      label: d.label,
      storageType: (d.storageType === "bucket" ? "bucket" : "local") as "local" | "bucket",
      fileUrl: d.fileUrl || "",
      bucketId: d.bucketId || 0,
      objectKey: d.objectKey || "",
      sizeBytes: d.sizeBytes != null ? Number(d.sizeBytes) : null,
      memberOnly: d.memberOnly,
      sort: d.sort,
    })),
  };
  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">编辑软件</h1>
      <p className="mb-5 text-sm text-zinc-500">修改后自动同步搜索索引；下线将从索引移除。下载条目整组替换保存。</p>
      <SoftwareForm cats={cats} buckets={buckets} initial={initial} />
    </div>
  );
}
