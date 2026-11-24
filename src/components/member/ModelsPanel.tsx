"use client";

import { useEffect, useState } from "react";
import VendorLogo from "@/components/VendorLogo";
import { pricingUnitSuffix } from "@/lib/gateway/pricing";
import { availabilityRate, buildModelSample } from "@/lib/model-detail";

// ─── v0.116 会员中心模型库：按厂商分组 + 卡片 / 表格双视图 ───
// 列：模型名称 / 上下文·时长 / 输入价格 / 输出价格 / 供应商（厂商 LOGO）
// 计价单位按模型计量方式自适应：token=积分/1M、image=积分/张、video/audio_second=积分/秒、request=积分/次、char=积分/千字符

type PricingInfo = {
  unit: string;
  memberInput: number;
  memberOutput: number | null;
};

type ModelItem = {
  id: number;
  name: string;
  displayName: string | null;
  endpointType: string;
  type: string;
  features: string[];
  remark: string | null;
  capabilities: { params: string[]; modalities: string[] };
  vendorLabel: string | null;
  ctxLabel: string | null;
  pricing: PricingInfo | null;
  stats: { calls: number; success: number } | null;
};

type VendorGroup = {
  id: number;
  name: string;
  slug: string;
  count: number;
  models: ModelItem[];
};

type ModelsData = {
  total: number;
  vendorCount: number;
  baseUrl: string;
  statsDays: number;
  vendors: VendorGroup[];
};

function PriceCell({ value, unit }: { value: number | null; unit: string }) {
  if (value == null || value <= 0) return <span className="text-zinc-600">—</span>;
  return (
    <span className="whitespace-nowrap text-sm font-semibold text-emerald-300">
      {value.toLocaleString("en-US")}
      <span className="ml-1 text-xs font-normal text-zinc-500">{pricingUnitSuffix(unit)}</span>
    </span>
  );
}

function PriceRow({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-zinc-500">{label}</span>
      <PriceCell value={value} unit={unit} />
    </div>
  );
}

function AvailabilityStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-zinc-100">{value}</p>
    </div>
  );
}

// 模型详情：能力说明 / 价格 / 可复制调用示例 / 近 7 天可用性
// 首字延迟、吞吐等未采集指标不展示推算值，明确标注「未采集」。
function ModelDetail({ m, baseUrl, onClose }: { m: ModelItem; baseUrl: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const sample = buildModelSample(m, baseUrl);
  const calls = m.stats?.calls ?? 0;
  const success = m.stats?.success ?? 0;
  const rate = availabilityRate(m.stats);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function copySample() {
    try {
      await navigator.clipboard.writeText(sample);
    } catch {
      // 非安全上下文兜底：临时 textarea + execCommand
      const ta = document.createElement("textarea");
      ta.value = sample;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-zinc-800 px-5 py-4">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-zinc-100">
              {m.displayName || m.name}
            </p>
            <p className="mt-0.5 truncate font-mono text-xs text-zinc-500">{m.name}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
              {m.type}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition hover:text-zinc-200"
            >
              关闭
            </button>
          </div>
        </div>

        <div className="px-5 py-4">
          {/* 能力说明 */}
          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
              能力说明
            </h4>
            <p className="whitespace-pre-wrap text-sm text-zinc-300">
              {m.remark?.trim() || "后台暂未填写能力说明。"}
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                {m.vendorLabel || "未知供应商"}
              </span>
              {m.ctxLabel && (
                <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                  {m.ctxLabel}
                </span>
              )}
              {m.features.map((f) => (
                <span
                  key={f}
                  className="rounded bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300"
                >
                  {f}
                </span>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {m.capabilities.modalities.map((x) => (
                <span
                  key={`mod-${x}`}
                  className="rounded bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300"
                >
                  模态 · {x}
                </span>
              ))}
              {m.capabilities.params.map((x) => (
                <span
                  key={`param-${x}`}
                  className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-400"
                >
                  {x}
                </span>
              ))}
            </div>
            {!m.capabilities.modalities.length && !m.capabilities.params.length && (
              <p className="mt-2 text-xs text-zinc-600">后台暂未配置能力参数。</p>
            )}
          </section>

          {/* 价格 */}
          <section className="mt-5 border-t border-zinc-800 pt-4">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
              价格（会员价）
            </h4>
            {m.pricing ? (
              <div className="max-w-xs space-y-1.5">
                {m.pricing.unit === "token" ? (
                  <>
                    <PriceRow label="输入" value={m.pricing.memberInput} unit={m.pricing.unit} />
                    <PriceRow label="输出" value={m.pricing.memberOutput} unit={m.pricing.unit} />
                  </>
                ) : (
                  <PriceRow label="单价" value={m.pricing.memberInput} unit={m.pricing.unit} />
                )}
              </div>
            ) : (
              <p className="text-sm text-zinc-500">待定价</p>
            )}
            <p className="mt-2 text-xs text-zinc-600">1 元 = 100 积分；仅展示会员价，不含内部成本。</p>
          </section>

          {/* 调用示例 */}
          <section className="mt-5 border-t border-zinc-800 pt-4">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                调用示例（OpenAI 兼容）
              </h4>
              <button
                type="button"
                onClick={copySample}
                className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition hover:border-emerald-500/50 hover:text-emerald-300"
              >
                {copied ? "已复制" : "复制"}
              </button>
            </div>
            <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-300">
              <code>{sample}</code>
            </pre>
            <p className="mt-2 text-xs text-zinc-600">
              将 YOUR_API_KEY 换成会员中心创建的 API Key；Base URL 取自站内「API 文档」配置。
            </p>
          </section>

          {/* 近 7 天可用性 */}
          <section className="mt-5 border-t border-zinc-800 pt-4">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
              近 7 天可用性
            </h4>
            {rate == null ? (
              <p className="text-sm text-zinc-400">近 7 天暂无调用，暂不评估可用性。</p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                <AvailabilityStat label="调用量" value={calls.toLocaleString("en-US")} />
                <AvailabilityStat label="成功 / 失败" value={`${success} / ${calls - success}`} />
                <AvailabilityStat
                  label="成功率"
                  value={`${rate.toFixed(1)}%`}
                />
              </div>
            )}
            <p className="mt-2 text-xs text-zinc-600">
              口径：成功率 = 成功调用 ÷ 总调用（站内 + API），数据来自调用日志。
              首字延迟 / 吞吐未采集，暂不展示。
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

export default function ModelsPanel() {
  const [data, setData] = useState<ModelsData | null>(null);
  const [err, setErr] = useState("");
  const [detail, setDetail] = useState<ModelItem | null>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [view, setView] = useState<"table" | "card">("table");

  // 视图偏好本地记忆（卡片 / 表格）
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("member-models-view");
      if (saved === "card" || saved === "table") setView(saved);
    } catch {
      /* 隐私模式禁用 localStorage 时忽略 */
    }
  }, []);

  function switchView(v: "table" | "card") {
    setView(v);
    try {
      window.localStorage.setItem("member-models-view", v);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/member/models");
        const d = await r.json();
        if (r.ok) {
          setData(d);
          // 默认展开前 3 个厂商
          const init: Record<number, boolean> = {};
          (d.vendors || []).slice(0, 3).forEach((v: VendorGroup) => (init[v.id] = true));
          setOpen(init);
        } else {
          setErr(d.error || "加载失败");
        }
      } catch {
        setErr("加载失败，请稍后重试");
      }
    })();
  }, []);

  return (
    <div>
      {/* 总览：全部模型计数 / 厂商计数 */}
      <div className="mb-4 flex flex-wrap items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div>
          <p className="text-xs text-zinc-500">全部模型</p>
          <p className="mt-1 text-3xl font-bold text-emerald-400">{data ? data.total : "—"}</p>
        </div>
        <div>
          <p className="text-xs text-zinc-500">模型厂商</p>
          <p className="mt-1 text-3xl font-bold text-emerald-400">{data ? data.vendorCount : "—"}</p>
        </div>
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1">
          {(["card", "table"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => switchView(v)}
              className={`rounded-md px-3 py-1 text-xs transition ${
                view === v ? "bg-emerald-500/15 text-emerald-300" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {v === "card" ? "卡片" : "表格"}
            </button>
          ))}
        </div>
        <p className="w-full text-xs text-zinc-500">
          以下为已上线的全部模型与会员价（1 元 = 100 积分）；token 模型按每百万 tokens 计价，视频按秒、图像按张
        </p>
      </div>

      {err && <p className="mb-2 text-xs text-rose-400">{err}</p>}

      {data == null && !err ? (
        <div className="rounded-xl border border-zinc-800 p-6 text-center text-sm text-zinc-500">加载中…</div>
      ) : (
        <div className="space-y-3">
          {(data?.vendors || []).map((v) => (
            <div key={v.id} className="overflow-hidden rounded-xl border border-zinc-800">
              {/* 厂商大栏目（折叠） */}
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [v.id]: !o[v.id] }))}
                className="flex w-full items-center gap-3 bg-zinc-900/60 px-4 py-3 text-left transition hover:bg-zinc-900"
              >
                <span className="text-zinc-500">{open[v.id] ? "▾" : "▸"}</span>
                <span className="text-sm font-semibold text-zinc-100">{v.name}</span>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">
                  {v.count} 个模型
                </span>
              </button>
              {/* 模型表格 */}
              {open[v.id] && view === "table" && (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] border-collapse text-left">
                    <thead>
                      <tr className="border-y border-zinc-800 bg-zinc-900/40 text-xs uppercase tracking-wide text-zinc-500">
                        <th className="px-4 py-2.5 font-medium">模型名称</th>
                        <th className="px-3 py-2.5 font-medium">上下文 / 时长</th>
                        <th className="px-3 py-2.5 font-medium">输入价格</th>
                        <th className="px-3 py-2.5 font-medium">输出价格</th>
                        <th className="px-3 py-2.5 font-medium">供应商</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/70">
                      {v.models.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-4 py-4 text-center text-sm text-zinc-500">
                            该厂商暂无上线模型
                          </td>
                        </tr>
                      ) : (
                        v.models.map((m) => (
                          <tr key={m.id} className="transition hover:bg-zinc-900/50">
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => setDetail(m)}
                                  className="text-left text-sm font-medium text-zinc-200 transition hover:text-emerald-300"
                                >
                                  {m.displayName || m.name}
                                </button>
                                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
                                  {m.type}
                                </span>
                              </div>
                              <p className="mt-0.5 font-mono text-xs text-zinc-600">{m.name}</p>
                            </td>
                            <td className="whitespace-nowrap px-3 py-3 text-sm text-zinc-400">
                              {m.ctxLabel || "—"}
                            </td>
                            <td className="px-3 py-3">
                              {m.pricing ? (
                                <PriceCell value={m.pricing.memberInput} unit={m.pricing.unit} />
                              ) : (
                                <span className="text-zinc-600">待定价</span>
                              )}
                            </td>
                            <td className="px-3 py-3">
                              {m.pricing ? (
                                <PriceCell value={m.pricing.memberOutput} unit={m.pricing.unit} />
                              ) : (
                                <span className="text-zinc-600">待定价</span>
                              )}
                            </td>
                            <td className="px-3 py-3">
                              <span className="flex items-center gap-2">
                                {m.vendorLabel && <VendorLogo vendor={m.vendorLabel} size={18} />}
                                <span className="text-sm text-zinc-300">{m.vendorLabel || v.name}</span>
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
              {/* 模型卡片 */}
              {open[v.id] && view === "card" && (
                <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
                  {v.models.length === 0 ? (
                    <p className="px-1 py-4 text-center text-sm text-zinc-500">该厂商暂无上线模型</p>
                  ) : (
                    v.models.map((m) => (
                      <div key={m.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-zinc-100">
                              {m.displayName || m.name}
                            </p>
                            <p className="mt-0.5 truncate font-mono text-xs text-zinc-600">{m.name}</p>
                          </div>
                          <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
                            {m.type}
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-zinc-500">{m.ctxLabel || "—"}</p>
                        <div className="mt-3 space-y-1.5 border-t border-zinc-800 pt-3">
                          {m.pricing ? (
                            m.pricing.unit === "token" ? (
                              <>
                                <PriceRow label="输入" value={m.pricing.memberInput} unit={m.pricing.unit} />
                                <PriceRow label="输出" value={m.pricing.memberOutput} unit={m.pricing.unit} />
                              </>
                            ) : (
                              <PriceRow label="单价" value={m.pricing.memberInput} unit={m.pricing.unit} />
                            )
                          ) : (
                            <span className="text-sm text-zinc-600">待定价</span>
                          )}
                        </div>
                        <div className="mt-3 flex items-center gap-2 border-t border-zinc-800 pt-2.5">
                          {m.vendorLabel && <VendorLogo vendor={m.vendorLabel} size={16} />}
                          <span className="truncate text-xs text-zinc-400">{m.vendorLabel || v.name}</span>
                          <button
                            type="button"
                            onClick={() => setDetail(m)}
                            className="ml-auto shrink-0 text-xs text-zinc-500 transition hover:text-emerald-300"
                          >
                            详情 / 调用示例
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {detail && (
        <ModelDetail
          m={detail}
          baseUrl={data?.baseUrl || "/v1"}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}
