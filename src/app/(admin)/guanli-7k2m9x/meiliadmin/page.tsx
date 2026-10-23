import { ADMIN_BASE } from "@/lib/admin-path";
import MeiliReindexToolbar from "@/components/admin/MeiliReindexToolbar";

export const dynamic = "force-dynamic";

export const metadata = { title: "搜索管理" };

// 搜索管理：Meiliadmin v1.4.0 以 iframe 内嵌在后台框架里（左侧菜单保持固定，不再跳出后台）
// SPA 实体在 ./app/[[...path]]/route.ts，API 代理在 ./proxy/[...path]/route.ts
export default function MeiliadminPage() {
  return (
    <div className="flex flex-col gap-3">
      <MeiliReindexToolbar />
      <iframe
        src={`${ADMIN_BASE}/meiliadmin/app/`}
        title="搜索管理（Meiliadmin）"
        className="h-[calc(100vh-180px)] min-h-[520px] w-full rounded-xl border border-zinc-800 bg-white"
      />
    </div>
  );
}
