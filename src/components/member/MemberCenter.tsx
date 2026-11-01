"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, translate as t, type DictKey } from "@/lib/i18n-client";
import MessageCenter from "./MessageCenter";

// ─── P4 用户中心：会员中心分区（余额 / 充值记录 / 用量明细 / 我的资产 / 消息·工单 / 我的发布） ───

type Grant = {
  id: number;
  grantType: string;
  total: number;
  remaining: number;
  expiresAt: string | null;
};

type Post = {
  id: number;
  title: string;
  status: string;
  viewCount: number;
  commentCount: number;
  createdAt: string;
  category: string;
  rejectReason: string | null;
  categoryName: string;
};

type PayOrderRow = {
  orderNo: string;
  packCode: string;
  credits: number;
  amountCents: number;
  channel: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
};

type UsageRow = {
  id: number;
  createdAt: string;
  feature: string;
  keyName: string | null;
  model: string;
  promptTokens: number;
  outputTokens: number;
  tokens: number;
  credits: number;
  status: string;
};

type AssetRow = {
  id: string;
  assetType: string;
  typeLabel: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  expireAt: string | null;
  daysLeft: number | null;
  expiringSoon: boolean;
  expired: boolean;
  directUrl: string | null;
};

type ApiKeyRow = {
  id: number;
  keyPrefix: string;
  status: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

const GRANT_TYPE: Record<string, string> = {
  subscription: "订阅",
  topup: "充值",
  gift: "赠送",
  trial: "试用",
};
const PAY_CHANNEL: Record<string, string> = {
  wechat: "微信支付",
  alipay: "支付宝",
  custom: "自定义",
  stripe: "Stripe",
  crypto: "加密货币",
};
const PAY_STATUS: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  failed: "失败",
  closed: "已关闭",
};
const PAY_BADGE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-300",
  paid: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-rose-500/15 text-rose-300",
  closed: "bg-zinc-700 text-zinc-400",
};
const USAGE_STATUS: Record<string, string> = {
  success: "成功",
  failed: "失败",
  blocked: "拦截",
};
const USAGE_BADGE: Record<string, string> = {
  success: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-rose-500/15 text-rose-300",
  blocked: "bg-amber-500/15 text-amber-300",
};
const ASSET_ICON: Record<string, string> = {
  image: "🖼️",
  video: "🎬",
  audio: "🎵",
  file: "📄",
};
const POST_STATUS_BADGE: Record<string, string> = {
  published: "bg-emerald-500/15 text-emerald-300",
  pending: "bg-amber-500/15 text-amber-300",
  rejected: "bg-rose-500/15 text-rose-300",
  draft: "bg-zinc-700 text-zinc-300",
};
const POST_STATUS_TEXT: Record<string, string> = {
  published: "已发布",
  pending: "审核中",
  rejected: "已驳回",
  draft: "草稿",
};

function fmt(d: string | Date | null) {
  if (!d) return "—";
  const x = new Date(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

type TabKey = "balance" | "pay" | "usage" | "apikeys" | "assets" | "messages" | "posts";
const TABS: { key: TabKey; labelKey: DictKey }[] = [
  { key: "balance", labelKey: "member.tabBalance" },
  { key: "pay", labelKey: "member.tabPay" },
  { key: "usage", labelKey: "member.tabUsage" },
  { key: "apikeys", labelKey: "member.tabApiKeys" },
  { key: "assets", labelKey: "member.tabAssets" },
  { key: "messages", labelKey: "member.tabMessages" },
  { key: "posts", labelKey: "member.tabPosts" },
];

export default function MemberCenter({
  balance,
  grants,
  posts,
  initialTab = "balance",
}: {
  balance: number;
  grants: Grant[];
  posts: Post[];
  initialTab?: string;
}) {
  const locale = useLocale();
  const [tab, setTab] = useState<TabKey>(
    TABS.some((x) => x.key === initialTab) ? (initialTab as TabKey) : "balance"
  );
  const [newTicketSignal, setNewTicketSignal] = useState(0);

  // 充值记录
  const [orders, setOrders] = useState<PayOrderRow[] | null>(null);
  const [payPage, setPayPage] = useState(1);
  const [payTotal, setPayTotal] = useState(0);
  const [payLoading, setPayLoading] = useState(false);
  const payPageSize = 10;

  // 用量明细
  const [usageChannel, setUsageChannel] = useState<"onsite" | "apikey">("onsite");
  const [usageView, setUsageView] = useState<"list" | "bykey" | "byday">("list");
  const [usageRows, setUsageRows] = useState<UsageRow[] | null>(null);
  const [aggRows, setAggRows] = useState<{ keyName?: string; day?: string; calls: number; tokens: number; credits: number }[] | null>(null);
  const [usagePage, setUsagePage] = useState(1);
  const [usageTotal, setUsageTotal] = useState(0);
  const usagePageSize = 20;

  // 我的资产
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [assetError, setAssetError] = useState("");
  const loadedRef = useRef({ pay: false, usage: false, assets: false, apikeys: false });

  // API Key
  const [apiKeys, setApiKeys] = useState<ApiKeyRow[] | null>(null);
  const [apiKeyError, setApiKeyError] = useState("");
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [keyExpireDays, setKeyExpireDays] = useState<"0" | "30" | "90" | "365">("0");
  const [creatingKey, setCreatingKey] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);

  const loadPay = useCallback(async (page: number) => {
    setPayLoading(true);
    try {
      const r = await fetch(`/api/member/pay/orders?page=${page}&pageSize=${payPageSize}`);
      const d = await r.json();
      if (r.ok) {
        setOrders(d.orders || []);
        setPayTotal(d.total || 0);
        setPayPage(page);
      }
    } catch {
      // 静默
    } finally {
      setPayLoading(false);
    }
  }, []);

  const loadUsage = useCallback(async (channel: "onsite" | "apikey", view: "list" | "bykey" | "byday", page: number) => {
    try {
      const r = await fetch(
        `/api/member/usage?channel=${channel}&view=${view}&page=${page}`
      );
      const d = await r.json();
      if (r.ok) {
        if (d.view === "list") {
          setUsageRows(d.rows || []);
          setUsageTotal(d.total || 0);
          setAggRows(null);
        } else {
          setAggRows(d.rows || []);
          setUsageRows(null);
        }
        setUsagePage(page);
      }
    } catch {
      // 静默
    }
  }, []);

  const loadAssets = useCallback(async () => {
    try {
      const r = await fetch("/api/member/assets");
      const d = await r.json();
      if (r.ok) setAssets(d.assets || []);
      else setAssetError(d.error || "加载失败");
    } catch {
      setAssetError("加载失败，请稍后重试");
    }
  }, []);

  const loadApiKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/member/keys");
      const d = await r.json();
      if (r.ok) setApiKeys(d.keys || []);
      else setApiKeyError(d.error || t(locale, "apiKeys.loadFailed"));
    } catch {
      setApiKeyError(t(locale, "apiKeys.loadFailed"));
    }
  }, [locale]);

  const createApiKey = useCallback(async () => {
    setCreatingKey(true);
    setApiKeyError("");
    try {
      const days = parseInt(keyExpireDays, 10);
      const body = days > 0
        ? { expiresAt: new Date(Date.now() + days * 86400000).toISOString() }
        : {};
      const r = await fetch("/api/member/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (r.ok) {
        setCreatedKey(d.key);
        setKeyCopied(false);
        setApiKeys(null); // 下次进入重新拉取
        loadedRef.current.apikeys = false;
      } else {
        setApiKeyError(d.error || t(locale, "apiKeys.createFailed"));
      }
    } catch {
      setApiKeyError(t(locale, "apiKeys.createFailed"));
    } finally {
      setCreatingKey(false);
    }
  }, [keyExpireDays, locale]);

  const revokeKey = useCallback(
    async (k: ApiKeyRow) => {
      if (!confirm(t(locale, "apiKeys.revokeConfirm"))) return;
      try {
        const r = await fetch(`/api/member/keys/${k.id}/revoke`, { method: "POST" });
        if (r.ok) loadApiKeys();
        else {
          const d = await r.json();
          setApiKeyError(d.error || t(locale, "apiKeys.loadFailed"));
        }
      } catch {
        setApiKeyError(t(locale, "apiKeys.loadFailed"));
      }
    },
    [loadApiKeys, locale]
  );

  // 切到对应 Tab 时懒加载
  useEffect(() => {
    if (tab === "pay" && !loadedRef.current.pay) {
      loadedRef.current.pay = true;
      loadPay(1);
    }
    if (tab === "usage" && !loadedRef.current.usage) {
      loadedRef.current.usage = true;
      loadUsage("onsite", "list", 1);
    }
    if (tab === "apikeys" && !loadedRef.current.apikeys) {
      loadedRef.current.apikeys = true;
      loadApiKeys();
    }
    if (tab === "assets" && !loadedRef.current.assets) {
      loadedRef.current.assets = true;
      loadAssets();
    }
  }, [tab, loadPay, loadUsage, loadAssets, loadApiKeys]);

  const downloadAsset = async (a: AssetRow) => {
    try {
      let url = a.directUrl;
      if (!url) {
        const r = await fetch(`/api/member/assets/${a.id}/download`);
        const d = await r.json();
        if (!r.ok) {
          setAssetError(d.error || "下载失败");
          return;
        }
        url = d.url;
      }
      if (url) window.open(url, "_blank", "noopener");
    } catch {
      setAssetError("下载失败，请稍后重试");
    }
  };

  const deleteAsset = async (a: AssetRow) => {
    if (!confirm(`确定删除「${a.fileName}」？删除后不可恢复，请确认已下载保存。`)) return;
    try {
      const r = await fetch(`/api/member/assets/${a.id}`, { method: "DELETE" });
      if (r.ok) loadAssets();
      else {
        const d = await r.json();
        setAssetError(d.error || "删除失败");
      }
    } catch {
      setAssetError("删除失败，请稍后重试");
    }
  };

  const th = "px-3 py-2.5 text-left text-xs font-medium text-zinc-500";
  const td = "px-3 py-2.5 text-sm text-zinc-300";

  return (
    <div className="mb-8">
      {/* Tab 栏 */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {TABS.map((x) => (
          <button
            key={x.key}
            type="button"
            onClick={() => setTab(x.key)}
            className={`rounded-lg px-3.5 py-2 text-sm transition ${
              tab === x.key
                ? "bg-emerald-500/15 font-medium text-emerald-300"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            {t(locale, x.labelKey)}
          </button>
        ))}
      </div>

      {/* ── 余额 ── */}
      {tab === "balance" && (
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
            <div>
              <p className="text-xs text-zinc-500">当前积分</p>
              <p className="mt-1 text-3xl font-bold text-emerald-400">{balance}</p>
            </div>
            <Link
              href="/recharge"
              className="ml-auto rounded-lg bg-emerald-500 px-5 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400"
            >
              充值
            </Link>
          </div>
          <h3 className="mb-2 text-sm font-semibold text-zinc-300">额度池明细</h3>
          <div className="overflow-hidden rounded-xl border border-zinc-800">
            {grants.length === 0 ? (
              <div className="p-6 text-center text-sm text-zinc-500">
                暂无积分额度，去
                <Link href="/recharge" className="mx-1 text-emerald-400 hover:underline">
                  充值
                </Link>
                获取积分
              </div>
            ) : (
              <table className="w-full">
                <thead className="bg-zinc-900/60">
                  <tr>
                    <th className={th}>类型</th>
                    <th className={th}>总额</th>
                    <th className={th}>剩余</th>
                    <th className={th}>过期时间</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/70">
                  {grants.map((g) => (
                    <tr key={g.id}>
                      <td className={td}>{GRANT_TYPE[g.grantType] || g.grantType}</td>
                      <td className={td}>{g.total}</td>
                      <td className={`${td} font-medium text-emerald-300`}>{g.remaining}</td>
                      <td className={`${td} text-xs`}>
                        {g.expiresAt ? fmt(g.expiresAt) : "永不过期"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── 充值记录 ── */}
      {tab === "pay" && (
        <div>
          <div className="overflow-hidden rounded-xl border border-zinc-800">
            {orders == null ? (
              <div className="p-6 text-center text-sm text-zinc-500">加载中…</div>
            ) : orders.length === 0 ? (
              <div className="p-6 text-center text-sm text-zinc-500">
                还没有充值记录，去
                <Link href="/recharge" className="mx-1 text-emerald-400 hover:underline">
                  充值
                </Link>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-zinc-900/60">
                    <tr>
                      <th className={th}>订单号</th>
                      <th className={th}>金额</th>
                      <th className={th}>积分</th>
                      <th className={th}>通道</th>
                      <th className={th}>时间</th>
                      <th className={th}>状态</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {orders.map((o) => (
                      <tr key={o.orderNo}>
                        <td className={`${td} text-xs text-zinc-400`}>{o.orderNo}</td>
                        <td className={td}>¥{(o.amountCents / 100).toFixed(2)}</td>
                        <td className={td}>{o.credits}</td>
                        <td className={td}>{PAY_CHANNEL[o.channel] || o.channel}</td>
                        <td className={`${td} text-xs`}>{fmt(o.createdAt)}</td>
                        <td className={td}>
                          <span className={`rounded px-1.5 py-0.5 text-xs ${PAY_BADGE[o.status] || ""}`}>
                            {PAY_STATUS[o.status] || o.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {orders != null && payTotal > payPageSize && (
            <div className="mt-3 flex items-center justify-center gap-3 text-sm text-zinc-400">
              <button
                type="button"
                disabled={payPage <= 1 || payLoading}
                onClick={() => loadPay(payPage - 1)}
                className="rounded-lg border border-zinc-700 px-3 py-1 hover:bg-zinc-800 disabled:opacity-40"
              >
                上一页
              </button>
              <span>
                {payPage} / {Math.ceil(payTotal / payPageSize)}（共 {payTotal} 条）
              </span>
              <button
                type="button"
                disabled={payPage >= Math.ceil(payTotal / payPageSize) || payLoading}
                onClick={() => loadPay(payPage + 1)}
                className="rounded-lg border border-zinc-700 px-3 py-1 hover:bg-zinc-800 disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── 用量明细 ── */}
      {tab === "usage" && (
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            {(["onsite", "apikey"] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setUsageChannel(c);
                  loadUsage(c, c === "apikey" ? usageView : "list", 1);
                }}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  usageChannel === c ? "bg-emerald-500/15 text-emerald-300" : "text-zinc-400 hover:bg-zinc-800"
                }`}
              >
                {c === "onsite" ? "本站使用" : "API Key 使用"}
              </button>
            ))}
            {usageChannel === "apikey" && (
              <div className="ml-auto flex items-center gap-1.5">
                {(
                  [
                    ["list", "明细"],
                    ["bykey", "按 Key"],
                    ["byday", "按日"],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      setUsageView(v);
                      loadUsage("apikey", v, 1);
                    }}
                    className={`rounded-lg px-2.5 py-1 text-xs ${
                      usageView === v ? "bg-zinc-800 text-emerald-300" : "text-zinc-500 hover:bg-zinc-800"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="overflow-hidden rounded-xl border border-zinc-800">
            {usageRows == null && aggRows == null ? (
              <div className="p-6 text-center text-sm text-zinc-500">加载中…</div>
            ) : usageRows != null && usageRows.length === 0 ? (
              <div className="p-6 text-center text-sm text-zinc-500">暂无使用记录</div>
            ) : aggRows != null && aggRows.length === 0 ? (
              <div className="p-6 text-center text-sm text-zinc-500">暂无使用记录</div>
            ) : usageRows != null ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-zinc-900/60">
                    <tr>
                      <th className={th}>时间</th>
                      {usageChannel === "apikey" ? <th className={th}>Key</th> : <th className={th}>功能</th>}
                      <th className={th}>模型</th>
                      <th className={th}>用量（tokens）</th>
                      <th className={th}>扣分</th>
                      {usageChannel === "onsite" && <th className={th}>状态</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {usageRows.map((r) => (
                      <tr key={r.id}>
                        <td className={`${td} text-xs`}>{fmt(r.createdAt)}</td>
                        {usageChannel === "apikey" ? (
                          <td className={td}>{r.keyName}</td>
                        ) : (
                          <td className={td}>{r.feature}</td>
                        )}
                        <td className={`${td} text-xs text-zinc-400`}>{r.model}</td>
                        <td className={`${td} text-xs`}>
                          {r.tokens}（入 {r.promptTokens} / 出 {r.outputTokens}）
                        </td>
                        <td className={td}>{r.credits}</td>
                        {usageChannel === "onsite" && (
                          <td className={td}>
                            <span className={`rounded px-1.5 py-0.5 text-xs ${USAGE_BADGE[r.status] || ""}`}>
                              {USAGE_STATUS[r.status] || r.status}
                            </span>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-zinc-900/60">
                    <tr>
                      <th className={th}>{usageView === "bykey" ? "Key" : "日期"}</th>
                      <th className={th}>调用次数</th>
                      <th className={th}>tokens</th>
                      <th className={th}>扣分</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {(aggRows || []).map((r, i) => (
                      <tr key={i}>
                        <td className={td}>{usageView === "bykey" ? r.keyName : r.day}</td>
                        <td className={td}>{r.calls}</td>
                        <td className={td}>{r.tokens}</td>
                        <td className={td}>{r.credits}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {usageRows != null && usageTotal > usagePageSize && (
            <div className="mt-3 flex items-center justify-center gap-3 text-sm text-zinc-400">
              <button
                type="button"
                disabled={usagePage <= 1}
                onClick={() => loadUsage(usageChannel, usageView, usagePage - 1)}
                className="rounded-lg border border-zinc-700 px-3 py-1 hover:bg-zinc-800 disabled:opacity-40"
              >
                上一页
              </button>
              <span>
                {usagePage} / {Math.ceil(usageTotal / usagePageSize)}（共 {usageTotal} 条）
              </span>
              <button
                type="button"
                disabled={usagePage >= Math.ceil(usageTotal / usagePageSize)}
                onClick={() => loadUsage(usageChannel, usageView, usagePage + 1)}
                className="rounded-lg border border-zinc-700 px-3 py-1 hover:bg-zinc-800 disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── API Key ── */}
      {tab === "apikeys" && (
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div>
              <h3 className="text-sm font-semibold text-zinc-300">{t(locale, "apiKeys.title")}</h3>
              <p className="mt-0.5 text-xs text-zinc-500">{t(locale, "apiKeys.sub")}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowCreateKey(true);
                setCreatedKey(null);
                setKeyCopied(false);
                setApiKeyError("");
              }}
              className="ml-auto rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400"
            >
              {t(locale, "apiKeys.create")}
            </button>
          </div>
          {apiKeyError && <p className="mb-2 text-xs text-rose-400">{apiKeyError}</p>}
          <div className="overflow-hidden rounded-xl border border-zinc-800">
            {apiKeys == null ? (
              <div className="p-6 text-center text-sm text-zinc-500">加载中…</div>
            ) : apiKeys.length === 0 ? (
              <div className="p-8 text-center text-sm text-zinc-500">{t(locale, "apiKeys.empty")}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-zinc-900/60">
                    <tr>
                      <th className={th}>{t(locale, "apiKeys.colPrefix")}</th>
                      <th className={th}>{t(locale, "apiKeys.colStatus")}</th>
                      <th className={th}>{t(locale, "apiKeys.colCreated")}</th>
                      <th className={th}>{t(locale, "apiKeys.colLastUsed")}</th>
                      <th className={th}>{t(locale, "apiKeys.colExpires")}</th>
                      <th className={th}></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {apiKeys.map((k) => {
                      const expired = !!k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now();
                      return (
                        <tr key={k.id}>
                          <td className={`${td} font-mono`}>{k.keyPrefix}…</td>
                          <td className={td}>
                            <span
                              className={`rounded px-1.5 py-0.5 text-xs ${
                                k.status === "active" && !expired
                                  ? "bg-emerald-500/15 text-emerald-300"
                                  : "bg-zinc-700 text-zinc-400"
                              }`}
                            >
                              {expired
                                ? t(locale, "apiKeys.expired")
                                : k.status === "active"
                                  ? t(locale, "apiKeys.statusActive")
                                  : t(locale, "apiKeys.statusRevoked")}
                            </span>
                          </td>
                          <td className={`${td} text-xs`}>{fmt(k.createdAt)}</td>
                          <td className={`${td} text-xs`}>
                            {k.lastUsedAt ? fmt(k.lastUsedAt) : t(locale, "apiKeys.neverUsed")}
                          </td>
                          <td className={`${td} text-xs`}>
                            {k.expiresAt ? fmt(k.expiresAt) : t(locale, "apiKeys.neverExpires")}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            {k.status === "active" && (
                              <button
                                type="button"
                                onClick={() => revokeKey(k)}
                                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-rose-500 hover:text-rose-300"
                              >
                                {t(locale, "apiKeys.revoke")}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 创建弹层（创建成功显示明文 + 复制 + 仅显示一次提示） */}
          {showCreateKey && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
              onClick={() => {
                if (!creatingKey) setShowCreateKey(false);
              }}
            >
              <div
                className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-6"
                onClick={(e) => e.stopPropagation()}
              >
                {createdKey ? (
                  <>
                    <h3 className="text-base font-semibold text-zinc-100">{t(locale, "apiKeys.createdTitle")}</h3>
                    <p className="mt-1 text-xs text-amber-400">⚠️ {t(locale, "apiKeys.onceOnly")}</p>
                    <div className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5">
                      <code className="min-w-0 flex-1 break-all font-mono text-xs text-emerald-300">{createdKey}</code>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(createdKey).catch(() => {});
                          setKeyCopied(true);
                        }}
                        className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-emerald-500 hover:text-emerald-300"
                      >
                        {keyCopied ? t(locale, "btn.copied") : t(locale, "btn.copy")}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setShowCreateKey(false);
                        setCreatedKey(null);
                        loadApiKeys();
                        loadedRef.current.apikeys = true;
                      }}
                      className="mt-4 w-full rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400"
                    >
                      {t(locale, "apiKeys.done")}
                    </button>
                  </>
                ) : (
                  <>
                    <h3 className="text-base font-semibold text-zinc-100">{t(locale, "apiKeys.createTitle")}</h3>
                    <label className="mt-4 block text-xs text-zinc-400">{t(locale, "apiKeys.expireLabel")}</label>
                    <select
                      value={keyExpireDays}
                      onChange={(e) => setKeyExpireDays(e.target.value as typeof keyExpireDays)}
                      className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200"
                    >
                      <option value="0">{t(locale, "apiKeys.expireNever")}</option>
                      <option value="30">{t(locale, "apiKeys.expire30")}</option>
                      <option value="90">{t(locale, "apiKeys.expire90")}</option>
                      <option value="365">{t(locale, "apiKeys.expire365")}</option>
                    </select>
                    {apiKeyError && <p className="mt-2 text-xs text-rose-400">{apiKeyError}</p>}
                    <div className="mt-5 flex gap-2">
                      <button
                        type="button"
                        onClick={() => setShowCreateKey(false)}
                        disabled={creatingKey}
                        className="flex-1 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                      >
                        {t(locale, "apiKeys.cancel")}
                      </button>
                      <button
                        type="button"
                        onClick={createApiKey}
                        disabled={creatingKey}
                        className="flex-1 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-40"
                      >
                        {creatingKey ? "…" : t(locale, "apiKeys.submit")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 我的资产 ── */}
      {tab === "assets" && (
        <div>
          {assetError && <p className="mb-2 text-xs text-rose-400">{assetError}</p>}
          <div className="overflow-hidden rounded-xl border border-zinc-800">
            {assets == null ? (
              <div className="p-6 text-center text-sm text-zinc-500">加载中…</div>
            ) : assets.length === 0 ? (
              <div className="p-8 text-center text-sm text-zinc-500">
                暂无生成资产。使用生图 / 生视频等生成功能后，产出的文件会保存在这里（默认保留 30 天）。
              </div>
            ) : (
              <ul className="divide-y divide-zinc-800/70">
                {assets.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span className="text-2xl">{ASSET_ICON[a.assetType] || "📄"}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-zinc-200">{a.fileName}</p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {a.typeLabel} · {fmtSize(a.sizeBytes)} · {fmt(a.createdAt)}
                      </p>
                      {a.expireAt && (
                        <p
                          className={`mt-0.5 text-xs ${
                            a.expired ? "text-rose-400" : a.expiringSoon ? "text-amber-400" : "text-zinc-500"
                          }`}
                        >
                          {a.expired
                            ? "已过期"
                            : a.expiringSoon
                              ? `⚠️ 快过期（剩 ${a.daysLeft} 天），请下载保存`
                              : `剩 ${a.daysLeft} 天过期`}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => downloadAsset(a)}
                        disabled={a.expired}
                        className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-emerald-500 hover:text-emerald-300 disabled:opacity-40"
                      >
                        下载
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteAsset(a)}
                        className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-rose-500 hover:text-rose-300"
                      >
                        删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ── 消息·工单 ── */}
      {tab === "messages" && <MessageCenter newTicketSignal={newTicketSignal} />}

      {/* ── 我的发布 ── */}
      {tab === "posts" && (
        <div className="overflow-hidden rounded-xl border border-zinc-800">
          {posts.length === 0 ? (
            <div className="p-6 text-center text-sm text-zinc-500">
              还没有发布过提示词　
              <Link href="/publish" className="text-emerald-400 hover:underline">
                去发布一条 →
              </Link>
            </div>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-zinc-800/70">
                {posts.map((p) => (
                  <tr key={p.id} className="hover:bg-zinc-900/40">
                    <td className="px-3 py-2.5">
                      <Link href={`/p/${p.id}`} className="text-zinc-200 hover:text-emerald-300">
                        {p.title}
                      </Link>
                      {p.status === "rejected" && p.rejectReason && (
                        <p className="mt-0.5 text-xs text-rose-400">{p.rejectReason}</p>
                      )}
                    </td>
                    <td className="hidden px-3 py-2.5 text-xs text-zinc-500 sm:table-cell">{p.categoryName}</td>
                    <td className="px-3 py-2.5 text-xs text-zinc-500">👁 {p.viewCount} · 💬 {p.commentCount}</td>
                    <td className="px-3 py-2.5 text-right">
                      <span className={`rounded px-1.5 py-0.5 text-xs ${POST_STATUS_BADGE[p.status]}`}>
                        {POST_STATUS_TEXT[p.status] || p.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 发票说明条 */}
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-xs text-zinc-400">
        <span>🧾</span>
        <span>{t(locale, "member.invoiceTip")}</span>
        <button
          type="button"
          onClick={() => {
            setTab("messages");
            setNewTicketSignal((s) => s + 1);
          }}
          className="ml-auto rounded-lg border border-emerald-600/60 px-3 py-1.5 text-emerald-400 hover:bg-emerald-900/30"
        >
          提工单
        </button>
      </div>
    </div>
  );
}
