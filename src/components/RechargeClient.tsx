"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, translate as t } from "@/lib/i18n-client";

type Pack = { packCode: string; priceCents: number; credits: number; bonusCredits: number };

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

export default function RechargeClient({ packs, channels }: { packs: Pack[]; channels: string[] }) {
  const locale = useLocale();
  const router = useRouter();
  const [packCode, setPackCode] = useState<string>(packs[0]?.packCode || "");
  const [channel, setChannel] = useState<string>(channels[0] || "");
  const [busy, setBusy] = useState(false);
  const [order, setOrder] = useState<OrderResult | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // 只展示后台启用中的支付方式（多接口并用）；全部关闭则前台不能支付
  const visible = CHANNELS.filter((c) => channels.includes(c.channel));
  const noChannel = visible.length === 0;
  const activeChannel = visible.some((c) => c.channel === channel) ? channel : (visible[0]?.channel || "");

  const buy = async () => {
    if (!packCode) {
      setMsg({ kind: "err", text: t(locale, "recharge.selectPack") });
      return;
    }
    if (noChannel) {
      setMsg({ kind: "err", text: t(locale, "recharge.noChannel") });
      return;
    }
    setBusy(true);
    setMsg(null);
    setOrder(null);
    try {
      const r = await fetch("/api/member/pay/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packCode, channel: activeChannel }),
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

  const sel = packs.find((p) => p.packCode === packCode);
  // 推荐标记：性价比（积分/元）最高的积分包
  const bestCode = packs.reduce<{ code: string; ratio: number }>(
    (a, p) => {
      const ratio = p.priceCents > 0 ? (p.credits + p.bonusCredits) / (p.priceCents / 100) : 0;
      return ratio > a.ratio ? { code: p.packCode, ratio } : a;
    },
    { code: "", ratio: 0 }
  ).code;

  return (
    <div className="mx-auto w-full max-w-3xl">
      {/* 头部横幅 */}
      <div
        className="relative overflow-hidden rounded-2xl border border-emerald-500/20 p-5"
        style={{
          backgroundImage:
            "radial-gradient(600px 200px at 10% -40%, rgba(16,185,129,0.18), transparent 60%), radial-gradient(500px 220px at 110% 130%, rgba(99,102,241,0.14), transparent 60%)",
          backgroundColor: "rgba(24,24,27,0.6)",
        }}
      >
        <div className="text-lg font-bold text-zinc-50">{t(locale, "recharge.title")}</div>
        <div className="mt-1 text-sm text-zinc-400">{t(locale, "recharge.subtitle")}</div>
      </div>

      {/* 积分包卡片 */}
      <h2 className="mb-3 mt-7 text-base font-semibold text-zinc-200">{t(locale, "recharge.packTitle")}</h2>
      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {packs.map((p) => {
          const active = packCode === p.packCode;
          return (
            <button
              key={p.packCode}
              type="button"
              onClick={() => setPackCode(p.packCode)}
              className={`relative overflow-hidden rounded-2xl border p-5 text-left transition ${
                active
                  ? "border-emerald-500 bg-emerald-500/10 shadow-[0_0_24px_-8px_rgba(16,185,129,0.5)]"
                  : "border-zinc-800 bg-zinc-900/60 hover:-translate-y-0.5 hover:border-zinc-600"
              }`}
            >
              {p.packCode === bestCode && (
                <span className="absolute right-0 top-0 rounded-bl-xl bg-amber-500/90 px-2.5 py-1 text-[11px] font-semibold text-zinc-950">
                  {t(locale, "recharge.recommended")}
                </span>
              )}
              <div className="text-2xl font-bold text-zinc-50">
                ¥{p.priceCents / 100}
              </div>
              <div className="mt-2 text-lg font-semibold text-emerald-300">
                {t(locale, "recharge.credits", { n: p.credits })}
              </div>
              {p.bonusCredits > 0 && (
                <div className="mt-1.5">
                  <span className="inline-block rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">
                    {t(locale, "recharge.bonus", { n: p.bonusCredits })}
                  </span>
                </div>
              )}
              <div className="mt-3 text-xs text-zinc-500">
                {t(locale, "recharge.totalCredits", { n: p.credits + p.bonusCredits })}
              </div>
              <span
                className={`absolute bottom-4 right-4 flex h-5 w-5 items-center justify-center rounded-full border text-[11px] ${
                  active ? "border-emerald-400 bg-emerald-500 text-zinc-950" : "border-zinc-700 text-transparent"
                }`}
              >
                ✓
              </span>
            </button>
          );
        })}
      </div>

      {/* 支付通道（只显示后台启用中的接口） */}
      <h2 className="mb-3 text-base font-semibold text-zinc-200">{t(locale, "recharge.channel")}</h2>
      {noChannel ? (
        <div className="mb-6 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {t(locale, "recharge.noChannel")}
        </div>
      ) : (
        <div className="mb-6 flex flex-wrap gap-2.5">
          {visible.map((c) => (
            <button
              key={c.channel}
              type="button"
              onClick={() => setChannel(c.channel)}
              className={`rounded-xl border px-5 py-2.5 text-sm transition ${
                activeChannel === c.channel
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-300 shadow-[0_0_18px_-8px_rgba(16,185,129,0.6)]"
                  : "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600"
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {/* 汇总 + 购买 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-5 py-4">
        <div className="text-sm text-zinc-400">
          {sel ? (
            <>
              <span className="text-zinc-200">¥{sel.priceCents / 100}</span>
              <span className="mx-2 text-zinc-600">·</span>
              {t(locale, "recharge.credits", { n: sel.credits })}
              {sel.bonusCredits > 0 && (
                <span className="ml-2 text-xs text-amber-300">
                  {t(locale, "recharge.bonus", { n: sel.bonusCredits })}
                </span>
              )}
            </>
          ) : (
            t(locale, "recharge.selectPack")
          )}
        </div>
        <button
          type="button"
          onClick={buy}
          disabled={busy || noChannel || !packCode}
          className="rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-400 px-8 py-2.5 text-sm font-semibold text-zinc-950 shadow-[0_8px_24px_-10px_rgba(16,185,129,0.7)] transition hover:brightness-110 disabled:opacity-50"
        >
          {busy ? t(locale, "recharge.creating") : sel ? `${t(locale, "recharge.buy")} ¥${sel.priceCents / 100}` : t(locale, "recharge.buy")}
        </button>
      </div>

      {msg && (
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
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
        <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
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
            className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
          >
            {t(locale, "recharge.mockPay")}
          </button>
        </div>
      )}
    </div>
  );
}
