import { requireAdmin } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ADMIN_BASE } from "@/lib/admin-path";
import UsageRecordsAdmin from "@/components/admin/UsageRecordsAdmin";

export const dynamic = "force-dynamic";
export const metadata = { title: "使用记录管理" };

// ─── 使用记录管理（独立菜单页）：全站模型调用明细（本站 / API KEY 两通道） ───
// 可按会员、通道、状态、关键词筛选，用于排查调用失败、拦截与扣分异常。
export default async function AdminUsageRecordsPage() {
  const admin = await requireAdmin();
  if (!admin) redirect(`${ADMIN_BASE}/login`);

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">使用记录管理</h1>
      <p className="mb-5 text-sm text-zinc-500">
        全站模型调用明细（本站消费 / KEY 消费），包含用量、扣分、状态与延迟，可按会员、通道、状态与关键词筛选。
      </p>
      <UsageRecordsAdmin />
    </div>
  );
}
