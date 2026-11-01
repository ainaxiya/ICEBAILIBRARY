import { RegisterSettingsForm } from "@/components/admin/SettingsForms";
export const dynamic = "force-dynamic";
export const metadata = { title: "注册设置" };
export default function Page() {
  return (
    <div>
      <h1 className="mb-5 text-xl font-bold">注册设置</h1>
      {/* PRO 订阅暂未开放：MemberPlan / UserSubscription 仅建表无业务入口（前台不售卖），
          支付代扣签约落地后一键开。注册赠送开关在「运营告警」页配置（默认关闭）。 */}
      <div className="mb-5 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
        <span>🚧</span>
        <span>PRO 订阅暂未开放：会员订阅仅建表就绪，前台不售卖，支付代扣签约落地后一键开。</span>
      </div>
      <RegisterSettingsForm />
    </div>
  );
}
