import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { ADMIN_BASE } from "@/lib/admin-path";
import PlaygroundAdminPanel from "@/components/admin/PlaygroundAdminPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "实验场" };

// 后台「实验场」栏目：TAB 分区（看板 / 规则 / 角色 / 消费线 / 维护）
export default async function AdminPlaygroundPage() {
  const admin = await requireAdmin();
  if (!admin) redirect(`${ADMIN_BASE}/login`);

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">实验场</h1>
      <p className="mb-5 text-xs text-zinc-300">
        实验场运行配置：运行看板、规则设置、虚拟角色、消费线与并发、维护开关分区管理，切换 TAB 刷新后保持当前位置。
      </p>
      <PlaygroundAdminPanel />
    </div>
  );
}
