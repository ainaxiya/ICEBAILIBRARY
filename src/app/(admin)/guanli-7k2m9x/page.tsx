import DashboardBoard from "@/components/admin/DashboardBoard";
import { getDashboardMetrics } from "@/lib/dashboard-metrics";

export const dynamic = "force-dynamic";

export const metadata = { title: "管理后台 · 仪表盘" };

// 后台首页：只保留运营与排障信息（经营/积分池/队列/告警/异常/增长/支付/实验场）
export default async function AdminHome() {
  const metrics = await getDashboardMetrics();

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">仪表盘</h1>
      <p className="mb-5 text-sm text-zinc-500">运营与排障</p>
      <DashboardBoard initial={metrics} />
    </div>
  );
}
