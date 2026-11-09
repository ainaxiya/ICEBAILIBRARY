import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { ADMIN_BASE } from "@/lib/admin-path";
import TicketDetail from "@/components/admin/TicketDetail";

export const dynamic = "force-dynamic";
export const metadata = { title: "工单详情" };

// v0.92 #4：工单客服式详情页（左栏会员信息 + 右栏消息流）
export default async function AdminTicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const admin = await requireAdmin();
  if (!admin) redirect(`${ADMIN_BASE}/login`);

  const { id } = await params;

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">工单详情</h1>
      <p className="mb-5 text-sm text-zinc-500">
        左栏为会员资料，右栏为对话消息流，回复支持富文本与图片。
      </p>
      <TicketDetail threadId={id} />
    </div>
  );
}
