import { requireAdmin } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ADMIN_BASE } from "@/lib/admin-path";
import CreditPacksAdmin from "@/components/admin/CreditPacksAdmin";

export const dynamic = "force-dynamic";
export const metadata = { title: "积分包管理" };

// ─── 积分包管理（独立菜单页）：充值积分包的增删改查与批量操作 ───
export default async function AdminCreditPacksPage() {
  const admin = await requireAdmin();
  if (!admin) redirect(`${ADMIN_BASE}/login`);

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">积分包管理</h1>
      <p className="mb-5 text-sm text-zinc-500">
        管理前台充值售卖的积分包：价格、积分、赠送、上下架与批量操作。
      </p>
      <CreditPacksAdmin />
    </div>
  );
}
