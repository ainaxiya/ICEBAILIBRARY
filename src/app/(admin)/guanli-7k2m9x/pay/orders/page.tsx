import { requireAdmin } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ADMIN_BASE } from "@/lib/admin-path";
import PayOrdersAdmin from "@/components/admin/PayOrdersAdmin";

export const dynamic = "force-dynamic";
export const metadata = { title: "订单管理" };

// ─── 订单管理（独立菜单页）：充值订单查询、手动补单入账、关单 ───
// 补单用于支付回调丢失时人工入账积分；关单后订单不可再支付。
export default async function AdminPayOrdersPage() {
  const admin = await requireAdmin();
  if (!admin) redirect(`${ADMIN_BASE}/login`);

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">订单管理</h1>
      <p className="mb-5 text-sm text-zinc-500">
        查询全站充值订单。待支付订单可手动「补单」入账积分（用于支付成功但回调丢失的场景），或「关单」终止订单。
      </p>
      <PayOrdersAdmin />
    </div>
  );
}
