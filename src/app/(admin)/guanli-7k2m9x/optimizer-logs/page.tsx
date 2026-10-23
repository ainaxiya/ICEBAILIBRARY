import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ADMIN_BASE } from "@/lib/admin-path";
import { PERMISSIONS, requirePerm } from "@/lib/rbac";
import Pagination from "@/components/Pagination";
import OptimizerLogTable from "@/components/admin/OptimizerLogTable";

export const dynamic = "force-dynamic";
export const metadata = { title: "优化器使用记录" };

const PAGE_SIZE = 20;

// 优化器使用记录：每次前台调用 /api/optimize 一条（IP/时间/输入/输出或错误）
// 只读，仅供后台查看，不关联用户账号
export default async function OptimizerLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const admin = await requireAdmin();
  if (!admin) redirect(`${ADMIN_BASE}/login`);
  const { ok } = await requirePerm(PERMISSIONS.OPTIMIZER_LOG_READ);
  if (!ok) redirect(ADMIN_BASE);

  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page || "1") || 1);

  const [logs, total] = await Promise.all([
    db.optimizerLog.findMany({
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.optimizerLog.count(),
  ]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const rows = logs.map((l) => ({
    id: l.id,
    ip: l.ip,
    input: l.input,
    output: l.output,
    error: l.error,
    createdAt: l.createdAt.toISOString(),
  }));

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">优化器使用记录</h1>
      <p className="mb-5 text-sm text-zinc-500">
        神器·全能提示词优化器的使用记录（只读）。共 {total} 条记录，每页 20 条，按使用时间倒序。
      </p>

      <OptimizerLogTable rows={rows} />

      <div className="mt-4 flex items-center justify-center text-sm text-zinc-400">
        <span>
          共 {total} 条，{page} / {Math.max(1, totalPages)}
        </span>
      </div>
      <Pagination page={page} totalPages={totalPages} basePath={`${ADMIN_BASE}/optimizer-logs`} query={{}} />
    </div>
  );
}
