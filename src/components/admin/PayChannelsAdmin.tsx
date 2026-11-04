"use client";

import { useEffect, useState } from "react";

// ─── 后台支付接口管理（独立菜单页「支付接口管理」） ───
// 五通道：微信 / 支付宝 / 自定义三方 / Stripe / 加密货币。
// 敏感字段用密码框输入：已配置时留空 = 保持原值不变，不回显明文。

type FieldMeta = { key: string; label: string; sensitive: boolean };
type ChannelMeta = { key: string; name: string; desc: string; fields: FieldMeta[] };

const CHANNEL_META: ChannelMeta[] = [
  {
    key: "wechat",
    name: "微信支付",
    desc: "微信支付商户 / JSAPI 支付参数。",
    fields: [
      { key: "appId", label: "应用 ID（AppID）", sensitive: false },
      { key: "mchId", label: "商户号（MchID）", sensitive: false },
      { key: "apiKey", label: "API 密钥", sensitive: true },
    ],
  },
  {
    key: "alipay",
    name: "支付宝",
    desc: "支付宝开放平台应用参数。",
    fields: [
      { key: "appId", label: "应用 ID", sensitive: false },
      { key: "privateKey", label: "应用私钥", sensitive: true },
      { key: "publicKey", label: "支付宝公钥", sensitive: false },
    ],
  },
  {
    key: "custom",
    name: "自定义三方",
    desc: "自建 / 第三方聚合支付网关。",
    fields: [
      { key: "gatewayUrl", label: "网关地址", sensitive: false },
      { key: "appId", label: "应用 ID", sensitive: false },
      { key: "key", label: "通信密钥", sensitive: true },
    ],
  },
  {
    key: "stripe",
    name: "Stripe",
    desc: "Stripe 国际支付（卡收款）。",
    fields: [
      { key: "secretKey", label: "Secret Key", sensitive: true },
      { key: "webhookSecret", label: "Webhook 签名密钥", sensitive: true },
    ],
  },
  {
    key: "crypto",
    name: "加密货币",
    desc: "USDT 等加密货币收款网关。",
    fields: [
      { key: "gatewayUrl", label: "网关地址", sensitive: false },
      { key: "address", label: "收款地址", sensitive: false },
      { key: "apiKey", label: "API 密钥", sensitive: true },
    ],
  },
];

type ChannelState = {
  enabled: boolean;
  values: Record<string, string>;
  has: Record<string, boolean>;
};

const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-950/80 px-3 py-2 text-sm outline-none focus:border-indigo-500";
const labelCls = "mb-1 block text-xs text-zinc-400";

export default function PayChannelsAdmin() {
  const [channels, setChannels] = useState<Record<string, ChannelState>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const load = () =>
    fetch("/api/admin/settings/pay-channels")
      .then((r) => r.json())
      .then((d) => {
        const raw: Record<string, { enabled?: boolean; has?: Record<string, boolean> } & Record<string, unknown>> =
          d.channels || {};
        const next: Record<string, ChannelState> = {};
        for (const meta of CHANNEL_META) {
          const c = raw[meta.key] || {};
          const values: Record<string, string> = {};
          for (const f of meta.fields) {
            // 敏感字段不回显：输入框恒为空，靠 has 标记提示「已配置」
            values[f.key] = f.sensitive ? "" : typeof c[f.key] === "string" ? (c[f.key] as string) : "";
          }
          next[meta.key] = { enabled: Boolean(c.enabled), values, has: c.has || {} };
        }
        setChannels(next);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));

  useEffect(() => {
    load();
  }, []);

  const setEnabled = (key: string, enabled: boolean) =>
    setChannels((s) => ({ ...s, [key]: { ...s[key], enabled } }));

  const setValue = (key: string, field: string, v: string) =>
    setChannels((s) => ({ ...s, [key]: { ...s[key], values: { ...s[key].values, [field]: v } } }));

  const save = async () => {
    setSaving(true);
    setMsg("");
    try {
      const body: Record<string, unknown> = {};
      for (const meta of CHANNEL_META) {
        const c = channels[meta.key];
        body[meta.key] = { enabled: Boolean(c?.enabled), ...c?.values };
      }
      const r = await fetch("/api/admin/settings/pay-channels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg(d.error || "保存失败");
        return;
      }
      setMsg("已保存 ✓（敏感字段留空即保持原值）");
      // 刷新已配置标记
      if (d.channels) {
        const next: Record<string, ChannelState> = {};
        for (const meta of CHANNEL_META) {
          const c = (d.channels as Record<string, { enabled?: boolean; has?: Record<string, boolean> }>)[meta.key] || {};
          const values: Record<string, string> = {};
          for (const f of meta.fields) values[f.key] = f.sensitive ? "" : typeof (c as Record<string, unknown>)[f.key] === "string" ? ((c as Record<string, unknown>)[f.key] as string) : "";
          next[meta.key] = { enabled: Boolean(c.enabled), values, has: c.has || {} };
        }
        setChannels(next);
      }
    } catch (e) {
      setMsg("保存失败：" + String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return <p className="text-sm text-zinc-500">加载中…</p>;

  return (
    <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <h2 className="text-base font-semibold text-zinc-100">支付渠道配置</h2>
      <p className="mt-1 text-xs text-zinc-500">
        配置五个支付通道的接入参数。敏感字段（密钥 / 私钥等）加密存储、不回显；已配置的字段留空表示保持原值不变。
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {CHANNEL_META.map((meta) => {
          const c = channels[meta.key];
          if (!c) return null;
          return (
            <div key={meta.key} className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-100">{meta.name}</h3>
                  <p className="mt-0.5 text-xs text-zinc-500">{meta.desc}</p>
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    onChange={(e) => setEnabled(meta.key, e.target.checked)}
                    className="h-4 w-4 accent-emerald-500"
                  />
                  启用
                </label>
              </div>
              <div className="mt-3 space-y-3">
                {meta.fields.map((f) => (
                  <div key={f.key}>
                    <label className={labelCls}>
                      {f.label}
                      {f.sensitive && <span className="ml-1 text-rose-400/80">（敏感）</span>}
                    </label>
                    <input
                      type={f.sensitive ? "password" : "text"}
                      autoComplete="off"
                      value={c.values[f.key] ?? ""}
                      placeholder={f.sensitive ? (c.has[f.key] ? "已配置，留空保持不变" : "未配置") : ""}
                      onChange={(e) => setValue(meta.key, f.key, e.target.value)}
                      className={inputCls}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存配置"}
        </button>
        {msg && <p className="text-xs text-emerald-400">{msg}</p>}
      </div>
    </div>
  );
}
