import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import ModelLibrary from "@/components/admin/ModelLibrary";

export const dynamic = "force-dynamic";
export const metadata = { title: "模型库管理" };

export default async function AdminModelsPage() {
  const admin = await requireAdmin();
  if (!admin) redirect("/guanli-7k2m9x/login");

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">模型库管理</h1>
      <p className="mb-5 text-sm text-zinc-500">
        聚合网关计费真源：厂商 / API Key（密文存储不回显）/ 模型上下线与定价调价历史 / 端点 / Key-模型路由绑定。
      </p>
      <ModelLibrary />
    </div>
  );
}
