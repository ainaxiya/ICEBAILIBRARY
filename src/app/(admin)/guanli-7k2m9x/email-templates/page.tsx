import { EmailTemplatesForm } from "@/components/admin/EmailSettings";
export const dynamic = "force-dynamic";
export const metadata = { title: "邮件模板" };
export default function Page() {
  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">邮件模板</h1>
      <p className="mb-5 text-sm text-zinc-500">注册验证码 / 找回密码验证码 / 测试邮件，标题与正文均可自定义变量插值</p>
      <EmailTemplatesForm />
    </div>
  );
}
