import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { ADMIN_BASE } from "@/lib/admin-path";
import AdminMessages from "@/components/admin/AdminMessages";

export const dynamic = "force-dynamic";
export const metadata = { title: "消息工单" };

// P4 后台：消息·工单（工单队列 + 消息群发/单发）
export default async function AdminMessagesPage() {
  const admin = await requireAdmin();
  if (!admin) redirect(`${ADMIN_BASE}/login`);

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">消息工单</h1>
      <p className="mb-5 text-sm text-zinc-500">
        用户工单队列（回复 / 关闭）与消息群发、单发通知。用户侧入口在会员中心「消息·工单」。
      </p>
      <AdminMessages />
    </div>
  );
}
