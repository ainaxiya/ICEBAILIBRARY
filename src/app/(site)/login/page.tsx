import { Suspense } from "react";
import AuthForm from "@/components/AuthForm";
import { getPublicSite } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const metadata = { title: "登录 / Sign in" };

export default async function LoginPage() {
  const site = await getPublicSite();
  return (
    <Suspense fallback={null}>
      <AuthForm mode="login" siteName={site.siteName} />
    </Suspense>
  );
}
