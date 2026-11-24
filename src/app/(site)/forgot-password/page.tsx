import { Suspense } from "react";
import ForgotPasswordForm from "@/components/ForgotPasswordForm";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "找回密码 / Reset password",
  robots: { index: false, follow: true },
  alternates: { canonical: "/forgot-password" },
};

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <div className="min-h-[70vh] px-4">
        <ForgotPasswordForm />
      </div>
    </Suspense>
  );
}
