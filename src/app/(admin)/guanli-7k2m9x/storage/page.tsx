import StorageManager from "@/components/admin/StorageManager";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "存储桶管理" };

export default async function AdminStoragePage() {
  const rows = await db.storageBucket.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true, name: true, type: true, endpoint: true, region: true, bucket: true,
      accessKey: true, publicBaseUrl: true, isDefault: true, enabled: true,
      _count: { select: { downloads: true } },
    },
  });
  const initial = rows.map(({ _count, ...r }) => ({ ...r, downloadCount: _count.downloads }));
  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">存储桶管理</h1>
      <p className="mb-5 text-sm text-zinc-500">
        配置 MinIO / S3 兼容对象存储，用于 AI 软件安装包的预签名直传与下载。SecretKey 加密存储，保存后不再回显。
      </p>
      <StorageManager initial={initial} />
    </div>
  );
}
