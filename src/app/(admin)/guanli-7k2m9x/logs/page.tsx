import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ADMIN_BASE } from "@/lib/admin-path";
import Link from "next/link";
import Pagination from "@/components/Pagination";

export const dynamic = "force-dynamic";
export const metadata = { title: "操作日志" };

const PAGE_SIZE = 50;

const ACTION_LABELS: Record<string, string> = {
  create: "创建",
  update: "更新",
  delete: "删除",
  batch_update: "批量操作",
  login: "登录",
  logout: "登出",
  reset: "重置",
  fetch_models: "获取模型",
  fetch_pricing: "获取原价",
  collect_fetch: "采集抓取",
  collect_import: "采集导入",
  collect_cancel: "取消采集",
  collect_items_delete: "采集条目删除",
  collect_items_skip: "采集条目跳过",
};

const TARGET_LABELS: Record<string, string> = {
  prompt: "提示词",
  user: "用户",
  admin: "管理员",
  category: "分类",
  role: "角色",
  setting: "设置",
  comment: "评论",
  ai_vendor: "AI 厂商",
  vendor_api_key: "API Key",
  ai_model: "模型",
  model_pricing: "模型定价",
  model_endpoint: "模型端点",
  fx_rate: "汇率",
  software: "软件",
  skill: "技能",
  storage_bucket: "存储桶",
  operational_alert: "运维告警",
  pay_order: "支付订单",
  message: "消息工单",
  crawl_job: "采集任务",
  crawl_source: "采集源",
};

// 操作列：（操作, 对象）组合的更贴切中文（如调价记录显示「更新价格」而非「创建」）
function actionLabelOf(action: string, targetType: string | null): string {
  if (action === "create" && targetType === "model_pricing") return "更新价格";
  return ACTION_LABELS[action] || action;
}

// 详情列：JSON 明细 → 简要中文说明（如「更新了 模型ID 235 名称 MiniMax-M3 的价格。」）
// 非 JSON 或无法识别时原样展示（截断 300 字）
const VERB_LABELS: Record<string, string> = {
  create: "新建了",
  update: "更新了",
  delete: "删除了",
  batch_update: "批量操作了",
  login: "登录了",
  logout: "登出了",
  reset: "重置了",
  fetch_models: "拉取了",
  fetch_pricing: "获取了",
  collect_fetch: "抓取了",
  collect_import: "导入了",
  collect_cancel: "取消了",
  collect_items_delete: "删除了",
  collect_items_skip: "跳过了",
};

// 对象尾缀：说明改动的是什么（「……的XX」）
const TAIL_LABELS: Record<string, string> = {
  model_pricing: "价格",
  model_endpoint: "端点",
  fx_rate: "汇率",
  ai_model: "模型信息",
  vendor_api_key: "API Key 配置",
  ai_vendor: "厂商信息",
  user: "资料",
  admin: "账号信息",
  setting: "设置",
  comment: "评论",
  prompt: "提示词信息",
  pay_order: "订单",
  message: "消息",
  skill: "技能信息",
  software: "软件信息",
  storage_bucket: "存储桶配置",
  operational_alert: "告警",
  crawl_job: "采集任务",
  crawl_source: "采集源",
};

// 计数字段中文（详情里没有名称、只有计数时用，如获取模型/获取原价的结果）
const COUNT_LABELS: Record<string, string> = {
  total: "共",
  created: "新建",
  updated: "更新",
  deleted: "删除",
  skipped: "跳过",
  deactivated: "标记下线",
  filled: "填入价格",
  priced: "填入价格",
  skippedHasPricing: "已有定价跳过",
  noMatch: "未匹配",
  pricingNoMatch: "价格未匹配",
  matched: "匹配",
  imported: "导入",
  failed: "失败",
  amount: "积分变动",
  before: "变动前",
  after: "变动后",
};

function formatDetailOf(action: string, targetType: string | null, targetId: number | null, detail: string | null): string {
  if (!detail) return "—";
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  } catch {
    /* 非 JSON：原样展示 */
  }
  if (!obj) return detail.length > 300 ? detail.slice(0, 300) + "…" : detail;

  const name = [obj.model, obj.name, obj.displayName, obj.title, obj.username, obj.nickname, obj.slug, obj.subject, obj.currency]
    .find((v) => typeof v === "string" && v.length > 0) as string | undefined;

  if (name) {
    // 有名目：「动词 + 对象 + ID x 名称 y 的尾巴」
    const idVal = obj.modelId ?? targetId;
    const idPart = idVal != null ? `ID ${String(idVal)} ` : "";
    const label = targetType === "model_pricing" ? "模型" : TARGET_LABELS[targetType || ""] || targetType || "对象";
    const tail = targetType && TAIL_LABELS[targetType] ? ` 的${TAIL_LABELS[targetType]}` : "";
    const verb = action === "create" && targetType === "model_pricing" ? "更新了" : VERB_LABELS[action] || "操作了";
    return `${verb} ${label}${idPart}名称 ${name}${tail}。`;
  }

  // 无名目：按计数/字段拼「动词：字段 值，……」
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || typeof v === "object") continue;
    const label = COUNT_LABELS[k] || k;
    parts.push(`${label} ${String(v)}`);
  }
  const verb = VERB_LABELS[action] || "操作了";
  const tail = targetType && TAIL_LABELS[targetType] ? TAIL_LABELS[targetType] : TARGET_LABELS[targetType || ""] || "";
  return parts.length > 0
    ? `${verb}${tail}：${parts.join("，")}。`
    : `${verb}${tail}。`;
}

export default async function AdminLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; action?: string; targetType?: string }>;
}) {
  const admin = await requireAdmin();
  if (!admin) redirect(`${ADMIN_BASE}/login`);

  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page || "1") || 1);
  const q = (sp.q || "").trim();
  const action = sp.action || "";
  const targetType = sp.targetType || "";

  type LogWhere = NonNullable<Parameters<typeof db.adminLog.findMany>[0]>["where"];
  const where: LogWhere = {};
  // 按管理员账号名模糊查询（历史日志可能挂 userId，一并兼容）
  if (q) {
    where.OR = [
      { admin: { username: { contains: q, mode: "insensitive" } } },
      { user: { username: { contains: q, mode: "insensitive" } } },
    ];
  }
  if (action) where.action = action;
  if (targetType) where.targetType = targetType;

  const [logs, total] = await Promise.all([
    db.adminLog.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        admin: { select: { id: true, username: true, nickname: true } },
        user: { select: { id: true, username: true, nickname: true } },
      },
    }),
    db.adminLog.count({ where }),
  ]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const buildUrl = (p: Partial<{ page: string; q: string; action: string; targetType: string }>) => {
    const params = new URLSearchParams();
    const merged = { page: String(page), q, action, targetType, ...p };
    if (merged.page && merged.page !== "1") params.set("page", merged.page);
    if (merged.q) params.set("q", merged.q);
    if (merged.action) params.set("action", merged.action);
    if (merged.targetType) params.set("targetType", merged.targetType);
    const qs = params.toString();
    return `${ADMIN_BASE}/logs${qs ? "?" + qs : ""}`;
  };

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">操作日志</h1>
      <p className="mb-5 text-sm text-zinc-500">
        管理员操作记录（只读）。共 {total} 条记录。
      </p>

      {/* 过滤栏 */}
      <form className="mb-4 flex flex-wrap gap-2">
        <select
          name="action"
          defaultValue={action}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none"
        >
          <option value="">全部操作</option>
          {Object.entries(ACTION_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          name="targetType"
          defaultValue={targetType}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none"
        >
          <option value="">全部对象</option>
          {Object.entries(TARGET_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <input
          name="q"
          type="text"
          defaultValue={q}
          placeholder="管理员账号"
          className="w-36 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
        />
        <button
          type="submit"
          className="rounded-lg bg-indigo-600 px-5 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
        >
          查询
        </button>
        {(action || targetType || q) && (
          <Link
            href={`${ADMIN_BASE}/logs`}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
          >
            清除
          </Link>
        )}
      </form>

      {/* 日志表格 */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-zinc-800 text-left text-xs text-zinc-500">
            <tr>
              <th className="px-3 py-2.5 w-40">时间</th>
              <th className="px-3 py-2.5">管理员</th>
              <th className="px-3 py-2.5 w-20">操作</th>
              <th className="px-3 py-2.5 w-20">对象类型</th>
              <th className="px-3 py-2.5 w-20">对象 ID</th>
              <th className="px-3 py-2.5">详情</th>
              <th className="px-3 py-2.5 w-32">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {logs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-zinc-600">
                  暂无日志记录
                </td>
              </tr>
            )}
            {logs.map((log) => {
              // 新日志挂 admin，迁移前历史日志挂 user
              const actor = log.admin || log.user;
              return (
                <tr key={log.id} className="align-top hover:bg-zinc-800/30">
                  <td className="px-3 py-2.5 text-xs text-zinc-500">
                    {log.createdAt.toLocaleString("zh-CN", { hour12: false })}
                  </td>
                  <td className="px-3 py-2.5 text-zinc-300">
                    {actor ? (
                      <span>
                        {actor.nickname || actor.username}
                        <span className="ml-1 text-xs text-zinc-500">#{actor.id}</span>
                        {log.admin ? (
                          <span className="ml-1.5 rounded bg-indigo-500/15 px-1 py-0.5 text-[10px] text-indigo-300">
                            管理员
                          </span>
                        ) : (
                          <span className="ml-1.5 rounded bg-zinc-700/50 px-1 py-0.5 text-[10px] text-zinc-400">
                            历史
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-zinc-600">已删除</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
                      {actionLabelOf(log.action, log.targetType)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-zinc-400">
                    {log.targetType ? TARGET_LABELS[log.targetType] || log.targetType : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-zinc-500">
                    {log.targetId || "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="max-w-md text-xs text-zinc-400">
                      {formatDetailOf(log.action, log.targetType, log.targetId, log.detail)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-zinc-500">{log.ip || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      <div className="mt-4 flex items-center justify-center text-sm text-zinc-400">
        <span>
          共 {total} 条，{page} / {Math.max(1, totalPages)}
        </span>
      </div>
      <Pagination
        page={page}
        totalPages={totalPages}
        basePath={`${ADMIN_BASE}/logs`}
        query={{ q, action, targetType }}
      />
    </div>
  );
}
