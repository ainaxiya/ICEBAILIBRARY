"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, translate as t } from "@/lib/i18n-client";

type Pack = { packCode: string; priceCents: number; credits: number };

const CHANNELS: { channel: string; name: string }[] = [
  { channel: "wechat", name: "微信支付" },
  { channel: "alipay", name: "支付宝" },
  { channel: "custom", name: "自定义网关" },
  { channel: "stripe", name: "Stripe" },
  { channel: "crypto", name: "加密货币" },
];

type OrderResult = {
  orderNo: string;
  channel: string;
  payUrl?: string;
  notifyPayload?: Record<string, unknown>;
};

export default function RechargeClient({ packs }: { packs: Pack[] }) {
  const locale = useLocale();
  const router = useRouter();
  const [packCode, setPackCode] = useState<string>(packs[0]?.packCode || "");
  const [channel, setChannel] = useState<string>("wechat");
  const [busy, setBusy] = useState(false);
  const [order, setOrder] = useState<OrderResult | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const buy = async () => {
    if (!packCode) {
      setMsg({ kind: "err", text: t(locale, "recharge.selectPack") });
      return;
    }
    setBusy(true);
    setMsg(null);
    setOrder(null);
    try {
      const r = await fetch("/api/member/pay/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packCode, channel }),
      });
      const d = await r.json();
      if (!r.ok) {
        setMsg({ kind: "err", text: t(locale, "recharge.payFail", { msg: d.error || r.status }) });
        return;
      }
      const params = (d.pay?.params || {}) as Record<string, unknown>;
      setOrder({
        orderNo: d.order.orderNo,
        channel: d.order.channel,
        payUrl: d.pay?.payUrl,
        notifyPayload: (params.notifyPayload as Record<string, unknown>) || undefined,
      });
      setMsg({ kind: "ok", text: t(locale, "recharge.orderCreated", { no: d.order.orderNo }) });
    } catch (e) {
      setMsg({ kind: "err", text: t(locale, "recharge.payFail", { msg: String(e) }) });
    } finally {
      setBusy(false);
    }
  };

  // 本地开发模式：用 create 返回的模拟回调载荷触发 notify，完成模拟支付
  const mockPay = async () => {
    if (!order?.notifyPayload) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/member/pay/notify/${order.channel}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(order.notifyPayload),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setMsg({ kind: "err", text: t(locale, "recharge.payFail", { msg: d.error || r.status }) });
        return;
      }
      setMsg({ kind: "ok", text: t(locale, "recharge.payOk") });
      setOrder(null);
      router.refresh();
    } catch (e) {
      setMsg({ kind: "err", text: t(locale, "recharge.payFail", { msg: String(e) }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {/* 积分包卡片 */}
      <h2 className="mb-3 text-base font-semibold text-zinc-200">{t(locale, "recharge.packTitle")}</h2>
      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {packs.map((p) => {
          const bonus = p.credits - p.priceCents;
          const active = packCode === p.packCode;
          return (
            <button
              key={p.packCode}
              type="button"
              onClick={() => setPackCode(p.packCode)}
              className={`rounded-xl border p-5 text-left transition ${
                active
                  ? "border-emerald-500 bg-emerald-500/10"
                  : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-600"
              }`}
            >
              <div className="text-lg font-bold text-zinc-50">¥{p.priceCents / 100}</div>
              <div className="mt-1 text-sm text-emerald-400">
                {t(locale, "recharge.credits", { n: p.credits })}
              </div>
              {bonus > 0 && (
                <div className="mt-1 inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300">
                  {t(locale, "recharge.bonus", { n: bonus })}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* 支付通道 */}
      <h2 className="mb-3 text-base font-semibold text-zinc-200">{t(locale, "recharge.channel")}</h2>
      <div className="mb-6 flex flex-wrap gap-2">
        {CHANNELS.map((c) => (
          <button
            key={c.channel}
            type="button"
            onClick={() => setChannel(c.channel)}
            className={`rounded-lg border px-4 py-2 text-sm transition ${
              channel === c.channel
                ? "border-emerald-500 bg-emerald-500/10 text-emerald-300"
                : "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600"
            }`}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={buy}
          disabled={busy}
          className="rounded-lg bg-emerald-500 px-6 py-2.5 text-sm font-medium text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
        >
          {busy ? t(locale, "recharge.creating") : t(locale, "recharge.buy")}
        </button>
        <span className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {t(locale, "recharge.mockTip")}
        </span>
      </div>

      {msg && (
        <div
          className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
            msg.kind === "ok"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : "border-rose-500/30 bg-rose-500/10 text-rose-300"
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* 模拟支付面板 */}
      {order && (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="text-sm text-zinc-300">
            <span className="text-zinc-500">orderNo：</span>
            {order.orderNo}
          </div>
          {order.payUrl && (
            <div className="mt-1 break-all text-xs text-zinc-500">
              <span className="text-zinc-600">payUrl：</span>
              {order.payUrl}
            </div>
          )}
          <button
            type="button"
            onClick={mockPay}
            disabled={busy}
            className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
          >
            {t(locale, "recharge.mockPay")}
          </button>
        </div>
      )}
    </div>
  );
}
