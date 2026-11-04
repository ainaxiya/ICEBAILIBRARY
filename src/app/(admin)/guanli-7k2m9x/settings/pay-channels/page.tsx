import { requireAdmin } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ADMIN_BASE } from "@/lib/admin-path";
import PayChannelsAdmin from "@/components/admin/PayChannelsAdmin";

export const dynamic = "force-dynamic";
export const metadata = { title: "支付接口管理" };

// ─── 支付接口管理（独立菜单页）：五通道接入参数 + 启用/禁用开关 ───
// 多接口并用；前台只展示启用中的支付方式，全部关闭则前台不能支付。
export default async function AdminPayChannelsPage() {
  const admin = await requireAdmin();
  if (!admin) redirect(`${ADMIN_BASE}/login`);

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">支付接口管理</h1>
      <p className="mb-5 text-sm text-zinc-500">
        管理支付接口的接入参数与启用状态。可多接口并用；前台用户只能选择启用中的支付方式，全部关闭时前台不能支付（没有可用的支付通道）。
      </p>
      <PayChannelsAdmin />
    </div>
  );
}
