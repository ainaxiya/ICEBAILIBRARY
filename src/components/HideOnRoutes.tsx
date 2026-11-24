"use client";

import { usePathname } from "next/navigation";

// 按路径隐藏子树（例如个别单页不渲染站点页脚）。
// 页脚在 (site)/layout 里统一渲染，无法用服务端条件排除，因此在客户端按路径门控。
export default function HideOnRoutes({
  paths,
  children,
}: {
  paths: string[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const hit = paths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return hit ? null : <>{children}</>;
}
