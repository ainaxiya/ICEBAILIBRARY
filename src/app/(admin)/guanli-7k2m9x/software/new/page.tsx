import SoftwareForm, { type SoftwareFormData } from "@/components/admin/SoftwareForm";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "新增软件" };

export default async function AdminSoftwareNewPage() {
  const [cats, buckets] = await Promise.all([
    db.softwareCategory.findMany({ orderBy: { sort: "asc" } }),
    db.storageBucket.findMany({ where: { enabled: true }, select: { id: true, name: true, isDefault: true }, orderBy: { id: "asc" } }),
  ]);
  const initial: SoftwareFormData = {
    slug: "", name: "", version: "", tagline: "", description: "",
    icon: "", categoryId: cats[0]?.id || 0, tags: [],
    sizeText: "", platform: "", language: "", officialUrl: "",
    status: "published",
    viewCount: 0, downloadCount: 0, commentCount: 0,
    publishedAt: "",
    downloads: [],
  };
  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">新增软件</h1>
      <p className="mb-5 text-sm text-zinc-500">填写软件信息与下载地址，保存后进入前台列表与搜索索引。图标外链会自动本地化。</p>
      <SoftwareForm cats={cats} buckets={buckets} initial={initial} />
    </div>
  );
}
