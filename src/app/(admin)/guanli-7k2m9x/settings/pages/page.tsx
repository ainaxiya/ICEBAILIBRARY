import { requireAdmin } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ADMIN_BASE } from "@/lib/admin-path";
import SitePagesModal from "@/components/admin/SitePagesModal";

export const dynamic = "force-dynamic";
export const metadata = { title: "单页内容管理" };

// ─── 单页内容管理（独立菜单页）：帮助/关于/联系/条款/隐私 单页富文本 ───
export default async function AdminSitePagesPage() {
  const admin = await requireAdmin();
  if (!admin) redirect(`${ADMIN_BASE}/login`);

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">单页内容管理</h1>
      <p className="mb-5 text-sm text-zinc-500">
        编辑前台固定单页（使用帮助 / 关于我们 / 联系我们 / 服务条款 / 隐私政策）的标题与富文本内容，支持插入图片/视频，保存后前台立即生效。
      </p>
      <SitePagesModal autoOpen />
    </div>
  );
}
