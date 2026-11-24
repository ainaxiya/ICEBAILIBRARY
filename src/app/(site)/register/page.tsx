import { Suspense } from "react";
import AuthShell from "@/components/AuthShell";
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
      <AuthShell mode="register" siteName={site.siteName} logoIcon={site.logoIcon || "/logo/icon.png"} />
    </Suspense>
  );
}
