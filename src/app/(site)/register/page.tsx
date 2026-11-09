import { Suspense } from "react";
import AuthForm from "@/components/AuthForm";
import { getPublicSite } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "注册 / Sign up",
  robots: { index: false, follow: true },
  alternates: { canonical: "/register" },
};

export default async function RegisterPage() {
  const site = await getPublicSite();
  return (
    <Suspense fallback={null}>
      <AuthForm mode="register" siteName={site.siteName} />
    </Suspense>
  );
}
