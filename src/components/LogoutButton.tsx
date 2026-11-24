"use client";

import { useLocale, translate as t } from "@/lib/i18n-client";
import { ADMIN_BASE } from "@/lib/admin-path";

// admin=true：清管理员 Cookie 并跳管理员登录页；否则清会员 Cookie 回首页
// className：传入时完全替换默认样式（用于嵌入不同底色的区域）
export default function LogoutButton({
  admin = false,
  className,
}: {
  admin?: boolean;
  className?: string;
}) {
  const locale = useLocale();
  return (
    <button
      onClick={async () => {
        await fetch(admin ? "/api/admin/auth/logout" : "/api/auth/logout", { method: "POST" });
        // 整页跳转：客户端路由跳转不重取登录状态，导航栏会停留在已登录状态
        window.location.assign(admin ? `${ADMIN_BASE}/login` : "/");
      }}
      className={
        className ||
        "rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:border-rose-500 hover:text-rose-300"
      }
    >
      {t(locale, "nav.logout")}
    </button>
  );
}
