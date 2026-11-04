import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import ApiDocsContent from "@/components/ApiDocsContent";
import ApiDocsAdminPanel from "@/components/admin/ApiDocsAdminPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "API 接口文档" };

// ─── 后台 · API 接口文档 ───
// 上方管理区（ApiDocsAdminPanel）：Base URL 配置 / 编辑文档内容 / 恢复默认文档；
// 下方文档预览与前台 /api-docs 共用同一份内容（ApiDocsContent：目录 + 正文 + 实时在线模型目录表）。
export default async function AdminApiDocsPage() {
  const admin = await requireAdmin();
  if (!admin) redirect("/guanli-7k2m9x/login");

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-xl font-bold">API 接口文档</h1>
          <p className="text-sm text-zinc-500">
            站外 OpenAI 兼容接口文档（聚合网关），与前台 /api-docs 为同一份内容，含实时在线模型目录。
          </p>
        </div>
        <a
          href="/api-docs"
          target="_blank"
          rel="noopener"
          className="inline-block shrink-0 rounded border border-emerald-700/60 px-2.5 py-1 text-xs tracking-widest text-emerald-400 transition hover:bg-emerald-900/40 hover:text-emerald-300"
        >
          前台查看
        </a>
      </div>

      {/* 管理区：文档设置（Base URL）/ 编辑文档内容 / 恢复默认文档 */}
      <ApiDocsAdminPanel />

      <ApiDocsContent />
    </div>
  );
}
