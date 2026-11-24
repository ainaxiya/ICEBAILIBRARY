import { EmailConfigForm } from "@/components/admin/EmailSettings";
export const dynamic = "force-dynamic";
export const metadata = { title: "邮箱服务" };
export default function Page() {
  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">邮箱服务</h1>
      <p className="mb-5 text-sm text-zinc-500">SMTP 配置、验证码策略与测试发送；注册验证码开关在「注册设置」页</p>
      <EmailConfigForm />
    </div>
  );
}
