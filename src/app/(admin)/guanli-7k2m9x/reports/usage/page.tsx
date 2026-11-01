import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import UsageReport from "@/components/admin/UsageReport";

export const dynamic = "force-dynamic";
export const metadata = { title: "消费报表" };

export default async function AdminUsageReportPage() {
  const admin = await requireAdmin();
  if (!admin) redirect("/guanli-7k2m9x/login");

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">消费报表</h1>
      <p className="mb-5 text-sm text-zinc-500">
        按日 / 按模型聚合网关调用：调用数、Tokens、用户扣分、内部成本与毛利（仅内部核算，不影响用户余额）。
      </p>
      <UsageReport />
    </div>
  );
}
