import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { ADMIN_BASE } from "@/lib/admin-path";
import OperationalAlerts from "@/components/admin/OperationalAlerts";

export const dynamic = "force-dynamic";
export const metadata = { title: "运营告警" };

// P6 后台：运营告警（余额/毛利/单用户异常消耗巡检 + 阈值配置 + 注册赠送开关）
export default async function AdminAlertsPage() {
  const admin = await requireAdmin();
  if (!admin) redirect(`${ADMIN_BASE}/login`);

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">运营告警</h1>
      <p className="mb-5 text-sm text-zinc-500">
        积分池余额、近 7 天毛利与单用户异常消耗巡检。阈值可配，命中生成告警记录，确认后归档。
      </p>
      <OperationalAlerts />
    </div>
  );
}
