import { requireAdmin } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ADMIN_BASE } from "@/lib/admin-path";
import CreditLedgerAdmin from "@/components/admin/CreditLedgerAdmin";

export const dynamic = "force-dynamic";
export const metadata = { title: "积分流水" };

// ─── 积分流水（独立菜单页）：全站积分变动明细，支持按会员与类型筛选 ───
// 变动类型：入账（grant）/ 消费（consume）/ 退回（refund）/ 调账（admin_adjust）。
export default async function AdminCreditLedgerPage() {
  const admin = await requireAdmin();
  if (!admin) redirect(`${ADMIN_BASE}/login`);

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">积分流水</h1>
      <p className="mb-5 text-sm text-zinc-500">
        全站会员积分变动明细（入账 / 消费 / 退回 / 调账），可按会员 userId 与变动类型筛选，用于对账与排查积分问题。
      </p>
      <CreditLedgerAdmin />
    </div>
  );
}
