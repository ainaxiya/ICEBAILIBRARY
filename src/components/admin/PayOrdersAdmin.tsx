"use client";

// 后台订单管理：搜索（订单号/会员）、状态/通道筛选、分页；
// 待支付（pending）行可手动补单入账（markPaid）或关单（close），其余状态不显示操作按钮。
import { useCallback, useEffect, useState } from "react";
import Pagination from "@/components/Pagination";

type Order = {
  id: number;
  orderNo: string;
  userId: number;
  username: string;
  packCode: string;
  amountCents: number;
  credits: number;
  channel: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
};

const PAGE_SIZE = 20;

const PAY_STATUS: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  failed: "失败",
  closed: "已关闭",
};
// 状态徽章配色参照会员中心 PAY_BADGE 风格
const PAY_BADGE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-300",
  paid: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-rose-500/15 text-rose-300",
  closed: "bg-zinc-700 text-zinc-400",
};
const PAY_CHANNEL: Record<string, string> = {
  wechat: "微信支付",
  alipay: "支付宝",
  custom: "自定义",
  stripe: "Stripe",
  crypto: "加密货币",
};

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : "—");
const selCls =
  "rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500";

export default function PayOrdersAdmin() {
  // 输入框草稿态 + 已应用筛选态（提交/切换下拉时才生效，避免每敲一个字就请求）
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [channel, setChannel] = useState("all");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [busyNo, setBusyNo] = useState<string | null>(null);

  const load = useCallback(async () => {
    const ps = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), status, channel });
    if (q) ps.set("q", q);
    try {
      const r = await fetch("/api/admin/pay/orders?" + ps.toString());
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(d.error || "加载失败");
        return;
      }
      setRows(d.items || []);
      setTotal(d.total || 0);
    } catch (e) {
      alert("加载失败：" + String(e));
    } finally {
      setLoaded(true);
    }
  }, [page, q, status, channel]);

  useEffect(() => {
    load();
  }, [load]);

  // 行操作：补单（手动入账）/ 关单，危险操作均先 confirm
  const act = async (action: "markPaid" | "close", orderNo: string) => {
    const tip =
      action === "markPaid"
        ? `确认为订单 ${orderNo} 手动补单入账？将为会员增加对应积分。`
        : `确认关闭订单 ${orderNo}？关单后不可再支付。`;
    if (!confirm(tip)) return;
    setBusyNo(orderNo);
    try {
      const r = await fetch("/api/admin/pay/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, orderNo }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(d.error || "操作失败");
        return;
      }
      alert(action === "markPaid" ? "已补单入账" : "已关单");
      load();
    } catch (e) {
      alert("操作失败：" + String(e));
    } finally {
      setBusyNo(null);
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQ(qInput.trim());
            setPage(1);
          }}
          className="flex gap-2"
        >
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="订单号 / 会员搜索…"
            className="min-w-[160px] flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 sm:min-w-[220px]"
          />
          <button className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">
            查询
          </button>
        </form>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className={selCls}
        >
          <option value="all">全部状态</option>
          <option value="pending">待支付</option>
          <option value="paid">已支付</option>
          <option value="failed">失败</option>
          <option value="closed">已关闭</option>
        </select>
        <select
          value={channel}
          onChange={(e) => {
            setChannel(e.target.value);
            setPage(1);
          }}
          className={selCls}
        >
          <option value="all">全部通道</option>
          {Object.entries(PAY_CHANNEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="bg-zinc-900/70 text-left text-xs text-zinc-500">
            <tr>
              <th className="px-4 py-3">订单号</th>
              <th className="px-4 py-3">会员</th>
              <th className="px-4 py-3">积分包</th>
              <th className="px-4 py-3">金额（元）</th>
              <th className="px-4 py-3">积分</th>
              <th className="px-4 py-3">通道</th>
              <th className="px-4 py-3">状态</th>
              <th className="px-4 py-3">支付时间</th>
              <th className="px-4 py-3">创建时间</th>
              <th className="px-4 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="border-t border-zinc-800/70 hover:bg-zinc-900/40">
                <td className="px-4 py-2.5 font-mono text-xs text-zinc-300">{o.orderNo}</td>
                <td className="px-4 py-2.5 font-medium text-zinc-200">{o.username}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-zinc-400">{o.packCode}</td>
                <td className="px-4 py-2.5 text-zinc-200">¥{(o.amountCents / 100).toFixed(2)}</td>
                <td className="px-4 py-2.5 text-zinc-300">{o.credits}</td>
                <td className="px-4 py-2.5 text-zinc-400">{PAY_CHANNEL[o.channel] || o.channel}</td>
                <td className="px-4 py-2.5">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${PAY_BADGE[o.status] || ""}`}>
                    {PAY_STATUS[o.status] || o.status}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs text-zinc-500">{fmt(o.paidAt)}</td>
                <td className="px-4 py-2.5 text-xs text-zinc-500">{fmt(o.createdAt)}</td>
                <td className="px-4 py-2.5">
                  {o.status === "pending" ? (
                    <div className="flex gap-2">
                      <button
                        onClick={() => act("markPaid", o.orderNo)}
                        disabled={busyNo === o.orderNo}
                        className="rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-50"
                      >
                        补单
                      </button>
                      <button
                        onClick={() => act("close", o.orderNo)}
                        disabled={busyNo === o.orderNo}
                        className="rounded bg-rose-700 px-3 py-1 text-xs text-white hover:bg-rose-600 disabled:opacity-50"
                      >
                        关单
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-zinc-600">—</span>
                  )}
                </td>
              </tr>
            ))}
            {loaded && rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-10 text-center text-sm text-zinc-600">
                  暂无订单
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPage={(n) => setPage(n)} />
    </div>
  );
}
