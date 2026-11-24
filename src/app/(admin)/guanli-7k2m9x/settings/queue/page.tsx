import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { ADMIN_BASE } from "@/lib/admin-path";
import QueueAdminPanel from "@/components/admin/QueueAdminPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "队列与并发" };

// P6 #22 后台：队列与并发设置（视频 / 音频 / 图片 / 文本 / 产物下载）
export default async function AdminQueueSettingsPage() {
  const admin = await requireAdmin();
  if (!admin) redirect(`${ADMIN_BASE}/login`);

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold text-zinc-100">队列与并发</h1>
      <p className="mb-5 text-sm text-zinc-300">
        TAB 分区：消费线状态、消费线设置、实验场维护开关。五条消费通道各自独立，并发数按 1–200 校验。
      </p>
      <QueueAdminPanel />
    </div>
  );
}
