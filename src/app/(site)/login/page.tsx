import { Suspense } from "react";
import AuthForm from "@/components/AuthForm";
import { getPublicSite } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "登录 / Sign in",
  // 登录页可被爬取（robots 屏蔽会导致 noindex 失效）但不收录；canonical 收敛 ?next= 参数变体
  robots: { index: false, follow: true },
  alternates: { canonical: "/login" },
};

export default async function LoginPage() {
  const site = await getPublicSite();
  return (
    <Suspense fallback={null}>
      <AuthForm mode="login" siteName={site.siteName} />
    </Suspense>
  );
}
