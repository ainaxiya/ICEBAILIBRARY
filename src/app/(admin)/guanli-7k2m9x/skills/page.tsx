import SkillList from "@/components/admin/SkillList";
import { db } from "@/lib/db";
import { ADMIN_BASE } from "@/lib/admin-path";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const metadata = { title: "技能管理" };

export default async function AdminSkillsPage() {
  const cats = await db.skillCategory.findMany({ orderBy: { sort: "asc" } });
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-xl font-bold">技能管理</h1>
        <div className="flex gap-2">
          <Link
            href={`${ADMIN_BASE}/skills/categories`}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            分类管理
          </Link>
          <Link
            href={`${ADMIN_BASE}/skills/new`}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
          >
            + 新增技能
          </Link>
        </div>
      </div>
      <p className="mb-5 text-sm text-zinc-500">
        管理 AI 技能（SKILL.md），仅后台可添加。发布后进入前台 /skills 与搜索索引。
      </p>
      <SkillList cats={cats} />
    </div>
  );
}
