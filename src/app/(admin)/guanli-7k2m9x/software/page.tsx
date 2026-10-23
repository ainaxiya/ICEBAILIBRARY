import SoftwareList from "@/components/admin/SoftwareList";
import { db } from "@/lib/db";
import { ADMIN_BASE } from "@/lib/admin-path";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const metadata = { title: "软件管理" };

export default async function AdminSoftwarePage() {
  const cats = await db.softwareCategory.findMany({ orderBy: { sort: "asc" } });
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-xl font-bold">软件管理</h1>
        <div className="flex gap-2">
          <Link
            href={`${ADMIN_BASE}/software/categories`}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            分类管理
          </Link>
          <Link
            href={`${ADMIN_BASE}/software/new`}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
          >
            + 新增软件
          </Link>
        </div>
      </div>
      <p className="mb-5 text-sm text-zinc-500">
        管理 AI 软件，仅后台可添加。发布后进入前台 /software 与搜索索引；下载条目支持本站文件与对象存储桶。
      </p>
      <SoftwareList cats={cats} />
    </div>
  );
}
