"use client";

import { useCallback, useEffect, useState } from "react";
import { totalCostMilli, displayCredits } from "@/lib/gateway/pricing";

// ─── P3 模型库管理：厂商 / API Key / 模型（定价·端点） ───
// Key 明文/密文永不回显：只展示 keyPrefix +「已配置」标记
// 调价 = 新增一行 ModelPricing（历史只增不改），成本/标价换算复用 lib/gateway/pricing

type Vendor = {
  id: number;
  name: string;
  slug: string;
  apiBase: string;
  protocol: string;
  status: string;
  remark: string | null;
  keyCount: number;
  modelCount: number;
};

type KeyRow = {
  id: number;
  vendorId: number;
  vendorName: string;
  name: string;
  keyPrefix: string;
  configured: boolean;
  status: string;
  remark: string | null;
};

type PricingRow = {
  id: number;
  meterBase: number;
  unit: string;
  inputPrice: number;
  outputPrice: number;
  currency: string;
  fxRateE8: number;
  multiplierBps: number;
  effectiveAt: string;
};

type EndpointRow = { id?: number; path: string; enabled: boolean };

type ModelRow = {
  id: number;
  vendorId: number;
  vendorName: string;
  name: string;
  displayName: string;
  endpointType: string;
  status: string;
  remark: string | null;
  endpoints: EndpointRow[];
  currentPricing: PricingRow | null;
  pricePreview: { costMilli: number; displayCredits: number } | null;
};

type ModelDetail = {
  model: { id: number; name: string; displayName: string; endpointType: string; status: string; remark: string | null; vendorName: string };
  currentPricing: PricingRow | null;
  pricings: PricingRow[];
  endpoints: EndpointRow[];
};

// 「获取所有模型」预览候选（可用且未入库的上游模型）
type FetchCandidate = { name: string; endpointType: string; path: string | null; shutdownDate: string | null; ownedBy: string | null };
type FetchPreview = {
  keyId: number;
  vendorName: string;
  total: number;
  counts: { candidates: number; inDb: number; skippedUnavailable: number; toDeactivate: number };
  candidates: FetchCandidate[];
};

const cardCls = "rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 mb-4";
const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-indigo-500";
const selectCls = inputCls;
const labelCls = "mb-1 block text-sm text-zinc-400";
const btnCls =
  "rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50";
const primaryBtnCls =
  "rounded-lg border border-emerald-700/60 bg-emerald-800/60 px-4 py-2 text-sm text-emerald-100 hover:bg-emerald-700/60 disabled:opacity-50";
const dangerBtnCls =
  "rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-900/40 disabled:opacity-50";
const thCls = "border-b border-zinc-800 px-3 py-2 text-left text-xs text-zinc-400";
const tdCls = "border-b border-zinc-800/60 px-3 py-2 text-sm text-zinc-300";

const STATUS_LABEL: Record<string, string> = {
  online: "在线",
  deprecated: "弃用",
  offline: "下线",
  active: "启用",
  disabled: "禁用",
};

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "online" || status === "active"
      ? "bg-emerald-500/15 text-emerald-400"
      : status === "deprecated"
        ? "bg-amber-500/15 text-amber-400"
        : "bg-zinc-700/50 text-zinc-400";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] ${cls}`}>{STATUS_LABEL[status] || status}</span>
  );
}

// 弹层外壳（风格对齐 SitePagesModal）
function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
      <div className={`mt-10 w-full ${wide ? "max-w-3xl" : "max-w-lg"} rounded-xl border border-zinc-700 bg-zinc-900 p-5`}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
          <button type="button" onClick={onClose} className="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function ModelLibrary() {
  const [tab, setTab] = useState<"vendors" | "keys" | "models">("models");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [filterStatus, setFilterStatus] = useState("");
  const [filterVendor, setFilterVendor] = useState(0);
  // 批量选择（四个资源列表通用的复选框选中项）
  const [sel, setSel] = useState<number[]>([]);

  // 弹层表单
  const [vendorForm, setVendorForm] = useState<(Partial<Vendor> & { mode: "create" | "edit" }) | null>(null);
  const [keyForm, setKeyForm] = useState<
    (Partial<KeyRow> & { mode: "create" | "edit"; apiKey?: string }) | null
  >(null);
  const [modelForm, setModelForm] = useState<
    (Partial<ModelRow> & { mode: "create" | "edit"; initInputPrice?: number; initOutputPrice?: number; initMultiplierBps?: number }) | null
  >(null);

  // 模型详情（定价历史/调价/端点/试算）
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [endpointDraft, setEndpointDraft] = useState<EndpointRow[]>([]);
  const [priceForm, setPriceForm] = useState({ inputPrice: "0", outputPrice: "0", currency: "CNY", multiplierBps: "150", effectiveAt: "" });
  const [calc, setCalc] = useState({ promptTokens: "1000", outputTokens: "500", costMilli: "1000" });

  // 「获取所有模型」选择入库弹层（预览候选 + 勾选）
  const [fetchPreview, setFetchPreview] = useState<FetchPreview | null>(null);
  const [fetchSel, setFetchSel] = useState<string[]>([]);

  const flash = (kind: "ok" | "err", text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 3000);
  };

  const apiCall = async (url: string, init?: RequestInit) => {
    const r = await fetch(url, init);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "请求失败");
    return d;
  };
  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // ─── 数据加载 ───
  const loadVendors = useCallback(async () => {
    try {
      const d = await apiCall("/api/admin/models/vendors");
      setVendors(d.vendors || []);
    } catch {
      /* 列表加载失败静默 */
    }
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      const d = await apiCall("/api/admin/models/keys");
      setKeys(d.keys || []);
    } catch {
      /* 静默 */
    }
  }, []);

  const loadModels = useCallback(async (status?: string, vendorId?: number) => {
    try {
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (vendorId) qs.set("vendorId", String(vendorId));
      const d = await apiCall(`/api/admin/models/models${qs.toString() ? `?${qs}` : ""}`);
      setModels(d.models || []);
    } catch {
      /* 静默 */
    }
  }, []);

  useEffect(() => {
    loadVendors();
    loadKeys();
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshCurrent = () => {
    if (tab === "vendors") loadVendors();
    if (tab === "keys") loadKeys();
    if (tab === "models") loadModels(filterStatus || undefined, filterVendor || undefined);
    loadKeys();
    loadModels();
    loadVendors();
  };

  // ─── 通用提交 ───
  const submit = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      flash("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeRow = async (label: string, url: string) => {
    if (!confirm(`确定删除${label}吗？此操作不可恢复。`)) return;
    await submit(async () => {
      await apiCall(url, { method: "DELETE" });
      flash("ok", "已删除");
      refreshCurrent();
    });
  };

  // ─── 获取所有模型：拉取上游模型清单预览（仅可用未入库候选），弹层勾选入库 ───
  const fetchModelsOfKey = async (k: KeyRow) => {
    setBusy(true);
    try {
      const d = await apiCall(`/api/admin/models/keys/${k.id}/fetch-models`);
      setFetchPreview({
        keyId: k.id,
        vendorName: k.vendorName,
        total: d.total,
        counts: d.counts,
        candidates: d.candidates || [],
      });
      setFetchSel((d.candidates || []).map((c: FetchCandidate) => c.name));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 勾选入库：仅创建勾选的候选模型（幂等），并同步已在库模型的可用性
  const importSelectedModels = async () => {
    if (!fetchPreview || fetchSel.length === 0 || busy) return;
    await submit(async () => {
      const d = await apiCall(
        `/api/admin/models/keys/${fetchPreview.keyId}/fetch-models`,
        jsonInit("POST", { names: fetchSel })
      );
      flash("ok", `已入库 ${d.created} 个模型（标记下线 ${d.deactivated} / 跳过已停用 ${d.skipped}）`);
      setFetchPreview(null);
      refreshCurrent();
    });
  };

  const toggleFetchSel = (name: string) =>
    setFetchSel((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));

  // ─── 批量选择与批量操作 ───
  const toggleSel = (id: number) =>
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const toggleAll = (ids: number[]) =>
    setSel(ids.every((id) => sel.includes(id)) ? [] : ids);

  const runBatch = async (action: "enable" | "disable" | "delete") => {
    if (sel.length === 0 || busy) return;
    const label = action === "delete" ? "删除" : action === "enable" ? "启用" : "禁用";
    if (action === "delete") {
      const tip = tab === "vendors" ? "删除厂商将级联删除其 Key/模型，" : "";
      if (!confirm(`确定${label}选中的 ${sel.length} 项吗？${tip}此操作不可恢复。`)) return;
    }
    await submit(async () => {
      const d = await apiCall("/api/admin/models/batch", jsonInit("POST", { resource: tab, action, ids: sel }));
      flash("ok", `已${label} ${d.affected ?? sel.length} 项`);
      setSel([]);
      refreshCurrent();
    });
  };

  // ─── 模型详情 ───
  const openDetail = async (id: number) => {
    await submit(async () => {
      const d = await apiCall(`/api/admin/models/models/${id}`);
      setDetail(d);
      setEndpointDraft((d.endpoints || []).map((e: EndpointRow) => ({ path: e.path, enabled: e.enabled })));
      setPriceForm({
        inputPrice: String(d.currentPricing?.inputPrice ?? 0),
        outputPrice: String(d.currentPricing?.outputPrice ?? 0),
        currency: d.currentPricing?.currency || "CNY",
        multiplierBps: String(d.currentPricing?.multiplierBps ?? 150),
        effectiveAt: "",
      });
    });
  };

  const savePricing = async () => {
    if (!detail) return;
    await submit(async () => {
      await apiCall(
        `/api/admin/models/models/${detail.model.id}/pricing`,
        jsonInit("POST", {
          inputPrice: Number(priceForm.inputPrice) || 0,
          outputPrice: Number(priceForm.outputPrice) || 0,
          currency: priceForm.currency || "CNY",
          multiplierBps: Math.max(1, Math.min(100000, Number(priceForm.multiplierBps) || 150)),
          ...(priceForm.effectiveAt ? { effectiveAt: new Date(priceForm.effectiveAt).toISOString() } : {}),
        })
      );
      flash("ok", "已新增调价记录（历史保留）");
      await openDetail(detail.model.id);
    });
  };

  const saveEndpoints = async () => {
    if (!detail) return;
    await submit(async () => {
      const d = await apiCall(
        `/api/admin/models/models/${detail.model.id}/endpoints`,
        jsonInit("PUT", {
          endpoints: endpointDraft
            .filter((e) => e.path.trim())
            .map((e) => ({ path: e.path.trim(), enabled: e.enabled })),
        })
      );
      setDetail({ ...detail, endpoints: d.endpoints || [] });
      flash("ok", "端点已保存");
    });
  };

  // ─── 定价试算（直接调 pricing.ts） ───
  const cur = detail?.currentPricing || null;
  const calcCost = cur ? totalCostMilli(cur, Number(calc.promptTokens) || 0, Number(calc.outputTokens) || 0) : 0;
  const calcCredits = cur ? displayCredits(calcCost, cur.multiplierBps) : 0;
  const manualCredits = cur ? displayCredits(Number(calc.costMilli) || 0, cur.multiplierBps) : 0;

  // 批量操作条（四个资源列表共用，选中后可批量启用/禁用/删除）
  const batchBar = (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-zinc-500">已选 {sel.length} 项</span>
      <button type="button" className={btnCls} disabled={busy || sel.length === 0} onClick={() => runBatch("enable")}>
        批量启用
      </button>
      <button type="button" className={btnCls} disabled={busy || sel.length === 0} onClick={() => runBatch("disable")}>
        批量禁用
      </button>
      <button type="button" className={dangerBtnCls} disabled={busy || sel.length === 0} onClick={() => runBatch("delete")}>
        批量删除
      </button>
      {tab === "vendors" && <span className="text-xs text-zinc-600">删除厂商会级联删除其 Key/模型</span>}
    </div>
  );

  const TABS = [
    { key: "models", label: "模型" },
    { key: "vendors", label: "厂商" },
    { key: "keys", label: "API Key" },
  ] as const;

  return (
    <div>
      {/* 标签页 */}
      <div className="mb-4 flex flex-wrap gap-1 border-b border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => { setTab(t.key); setSel([]); }}
            className={`-mb-px rounded-t-lg px-4 py-2 text-sm ${
              tab === t.key
                ? "border-b-2 border-emerald-500 text-emerald-300"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {msg && (
        <p className={`mb-3 text-sm ${msg.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</p>
      )}

      {/* ─── 模型 ─── */}
      {tab === "models" && (
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <select value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value); loadModels(e.target.value || undefined, filterVendor || undefined); }} className={`${selectCls} w-36!`}>
              <option value="">全部状态</option>
              <option value="online">在线</option>
              <option value="deprecated">弃用</option>
              <option value="offline">下线</option>
            </select>
            <select value={filterVendor} onChange={(e) => { setFilterVendor(Number(e.target.value)); loadModels(filterStatus || undefined, Number(e.target.value) || undefined); }} className={`${selectCls} w-44!`}>
              <option value={0}>全部厂商</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
            <button type="button" className={primaryBtnCls} onClick={() => setModelForm({ mode: "create", vendorId: vendors[0]?.id, endpointType: "chat", status: "online", initInputPrice: 0, initOutputPrice: 0, initMultiplierBps: 150 })}>
              新建模型
            </button>
          </div>
          {batchBar}
          <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/50">
            <table className="w-full min-w-[900px]">
              <thead>
                <tr>
                  <th className={thCls}>
                    <input
                      type="checkbox"
                      checked={models.length > 0 && models.every((m) => sel.includes(m.id))}
                      onChange={() => toggleAll(models.map((m) => m.id))}
                    />
                  </th>
                  <th className={thCls}>ID</th>
                  <th className={thCls}>厂商</th>
                  <th className={thCls}>模型</th>
                  <th className={thCls}>类型</th>
                  <th className={thCls}>状态</th>
                  <th className={thCls}>当前定价（入/出）</th>
                  <th className={thCls}>加价系数</th>
                  <th className={thCls}>成本预览</th>
                  <th className={thCls}>操作</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.id} className="hover:bg-zinc-800/40">
                    <td className={tdCls}>
                      <input type="checkbox" checked={sel.includes(m.id)} onChange={() => toggleSel(m.id)} />
                    </td>
                    <td className={tdCls}>{m.id}</td>
                    <td className={tdCls}>{m.vendorName}</td>
                    <td className={tdCls}>
                      <div>{m.displayName}</div>
                      <div className="text-xs text-zinc-500">{m.name}</div>
                    </td>
                    <td className={tdCls}>{m.endpointType}</td>
                    <td className={tdCls}><StatusBadge status={m.status} /></td>
                    <td className={tdCls}>
                      {m.currentPricing
                        ? `${m.currentPricing.inputPrice} / ${m.currentPricing.outputPrice} ${m.currentPricing.currency}`
                        : <span className="text-zinc-500">未定价</span>}
                    </td>
                    <td className={tdCls}>{m.currentPricing ? `${(m.currentPricing.multiplierBps / 10000).toFixed(2)}x` : "-"}</td>
                    <td className={tdCls}>
                      {m.pricePreview
                        ? `${m.pricePreview.costMilli} 毫 → ${m.pricePreview.displayCredits} 分`
                        : "-"}
                    </td>
                    <td className={tdCls}>
                      <div className="flex gap-2">
                        <button type="button" className={btnCls} onClick={() => openDetail(m.id)}>详情</button>
                        <button type="button" className={btnCls} onClick={() => setModelForm({ mode: "edit", ...m })}>编辑</button>
                        <button type="button" className={dangerBtnCls} onClick={() => removeRow(`模型「${m.displayName}」`, `/api/admin/models/models/${m.id}`)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {models.length === 0 && (
                  <tr><td className={`${tdCls} text-center text-zinc-500`} colSpan={10}>暂无模型，点右上「新建模型」创建</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── 厂商 ─── */}
      {tab === "vendors" && (
        <div>
          <div className="mb-4">
            <button type="button" className={primaryBtnCls} onClick={() => setVendorForm({ mode: "create", protocol: "openai", status: "online" })}>
              新建厂商
            </button>
          </div>
          {batchBar}
          <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/50">
            <table className="w-full min-w-[800px]">
              <thead>
                <tr>
                  <th className={thCls}>
                    <input
                      type="checkbox"
                      checked={vendors.length > 0 && vendors.every((v) => sel.includes(v.id))}
                      onChange={() => toggleAll(vendors.map((v) => v.id))}
                    />
                  </th>
                  <th className={thCls}>ID</th>
                  <th className={thCls}>名称</th>
                  <th className={thCls}>标识</th>
                  <th className={thCls}>API Base</th>
                  <th className={thCls}>协议</th>
                  <th className={thCls}>状态</th>
                  <th className={thCls}>Key/模型</th>
                  <th className={thCls}>操作</th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((v) => (
                  <tr key={v.id} className="hover:bg-zinc-800/40">
                    <td className={tdCls}>
                      <input type="checkbox" checked={sel.includes(v.id)} onChange={() => toggleSel(v.id)} />
                    </td>
                    <td className={tdCls}>{v.id}</td>
                    <td className={tdCls}>{v.name}</td>
                    <td className={tdCls}>{v.slug}</td>
                    <td className={`${tdCls} max-w-[260px] truncate`}>{v.apiBase}</td>
                    <td className={tdCls}>{v.protocol}</td>
                    <td className={tdCls}><StatusBadge status={v.status} /></td>
                    <td className={tdCls}>{v.keyCount} / {v.modelCount}</td>
                    <td className={tdCls}>
                      <div className="flex gap-2">
                        <button type="button" className={btnCls} onClick={() => setVendorForm({ mode: "edit", ...v })}>编辑</button>
                        <button type="button" className={dangerBtnCls} onClick={() => removeRow(`厂商「${v.name}」（将级联删除其 Key/模型）`, `/api/admin/models/vendors/${v.id}`)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {vendors.length === 0 && (
                  <tr><td className={`${tdCls} text-center text-zinc-500`} colSpan={9}>暂无厂商</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── API Key ─── */}
      {tab === "keys" && (
        <div>
          <div className="mb-4">
            <button type="button" className={primaryBtnCls} onClick={() => setKeyForm({ mode: "create", vendorId: vendors[0]?.id, status: "active" })}>
              新建 Key
            </button>
          </div>
          {batchBar}
          <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/50">
            <table className="w-full min-w-[800px]">
              <thead>
                <tr>
                  <th className={thCls}>
                    <input
                      type="checkbox"
                      checked={keys.length > 0 && keys.every((k) => sel.includes(k.id))}
                      onChange={() => toggleAll(keys.map((k) => k.id))}
                    />
                  </th>
                  <th className={thCls}>ID</th>
                  <th className={thCls}>厂商</th>
                  <th className={thCls}>备注名</th>
                  <th className={thCls}>Key</th>
                  <th className={thCls}>状态</th>
                  <th className={thCls}>操作</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="hover:bg-zinc-800/40">
                    <td className={tdCls}>
                      <input type="checkbox" checked={sel.includes(k.id)} onChange={() => toggleSel(k.id)} />
                    </td>
                    <td className={tdCls}>{k.id}</td>
                    <td className={tdCls}>{k.vendorName}</td>
                    <td className={tdCls}>{k.name}</td>
                    <td className={tdCls}>
                      <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">{k.keyPrefix}</code>
                      <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-400">已配置</span>
                    </td>
                    <td className={tdCls}><StatusBadge status={k.status} /></td>
                    <td className={tdCls}>
                      <div className="flex gap-2">
                        <button type="button" className={btnCls} disabled={busy} onClick={() => fetchModelsOfKey(k)}>获取所有模型</button>
                        <button type="button" className={btnCls} onClick={() => setKeyForm({ mode: "edit", ...k })}>编辑</button>
                        <button type="button" className={dangerBtnCls} onClick={() => removeRow(`Key「${k.name}」`, `/api/admin/models/keys/${k.id}`)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {keys.length === 0 && (
                  <tr><td className={`${tdCls} text-center text-zinc-500`} colSpan={7}>暂无 Key</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── 厂商弹层 ─── */}
      {vendorForm && (
        <Modal title={vendorForm.mode === "create" ? "新建厂商" : "编辑厂商"} onClose={() => setVendorForm(null)}>
          <div className="space-y-3">
            <div>
              <label className={labelCls}>名称 *</label>
              <input className={inputCls} value={vendorForm.name || ""} onChange={(e) => setVendorForm({ ...vendorForm, name: e.target.value })} placeholder="DeepSeek / 多模型平台" />
            </div>
            <div>
              <label className={labelCls}>标识 slug *</label>
              <input className={inputCls} value={vendorForm.slug || ""} onChange={(e) => setVendorForm({ ...vendorForm, slug: e.target.value })} placeholder="deepseek / siliconflow" />
            </div>
            <div>
              <label className={labelCls}>API Base *</label>
              <input className={inputCls} value={vendorForm.apiBase || ""} onChange={(e) => setVendorForm({ ...vendorForm, apiBase: e.target.value })} placeholder="https://api.example.com/v1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>协议</label>
                <select className={selectCls} value={vendorForm.protocol || "openai"} onChange={(e) => setVendorForm({ ...vendorForm, protocol: e.target.value })}>
                  <option value="openai">OpenAI API</option>
                  <option value="anthropic">Anthropic API</option>
                  <option value="gemini">Gemini API</option>
                  {vendorForm.protocol && !["openai", "anthropic", "gemini"].includes(vendorForm.protocol) && (
                    <option value={vendorForm.protocol}>{vendorForm.protocol}</option>
                  )}
                </select>
              </div>
              <div>
                <label className={labelCls}>状态</label>
                <select className={selectCls} value={vendorForm.status || "online"} onChange={(e) => setVendorForm({ ...vendorForm, status: e.target.value })}>
                  <option value="online">在线</option>
                  <option value="deprecated">弃用</option>
                  <option value="offline">下线</option>
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls}>备注</label>
              <input className={inputCls} value={vendorForm.remark || ""} onChange={(e) => setVendorForm({ ...vendorForm, remark: e.target.value })} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className={btnCls} onClick={() => setVendorForm(null)}>取消</button>
              <button
                type="button"
                className={primaryBtnCls}
                disabled={busy || !vendorForm.name || !vendorForm.slug || !vendorForm.apiBase}
                onClick={() =>
                  submit(async () => {
                    const body = {
                      name: vendorForm.name?.trim(),
                      slug: vendorForm.slug?.trim(),
                      apiBase: vendorForm.apiBase?.trim(),
                      protocol: vendorForm.protocol,
                      status: vendorForm.status,
                      remark: vendorForm.remark || undefined,
                    };
                    if (vendorForm.mode === "create") {
                      await apiCall("/api/admin/models/vendors", jsonInit("POST", body));
                    } else {
                      await apiCall(`/api/admin/models/vendors/${vendorForm.id}`, jsonInit("PUT", body));
                    }
                    flash("ok", "厂商已保存");
                    setVendorForm(null);
                    refreshCurrent();
                  })
                }
              >
                保存
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ─── Key 弹层（明文只进不出） ─── */}
      {keyForm && (
        <Modal title={keyForm.mode === "create" ? "新建 API Key" : "编辑 API Key"} onClose={() => setKeyForm(null)}>
          <div className="space-y-3">
            <div>
              <label className={labelCls}>厂商 *</label>
              <select className={selectCls} value={keyForm.vendorId || ""} onChange={(e) => setKeyForm({ ...keyForm, vendorId: Number(e.target.value) })} disabled={keyForm.mode === "edit"}>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>备注名 *</label>
              <input className={inputCls} value={keyForm.name || ""} onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })} placeholder="主账号 Key / 备用 Key" />
            </div>
            <div>
              <label className={labelCls}>{keyForm.mode === "create" ? "API Key 明文 *" : "轮换 Key（留空保持不变）"}</label>
              <input
                type="password"
                className={inputCls}
                value={keyForm.apiKey || ""}
                onChange={(e) => setKeyForm({ ...keyForm, apiKey: e.target.value })}
                placeholder={keyForm.mode === "edit" ? `${keyForm.keyPrefix}（已配置，不回显）` : "sk-..."}
                autoComplete="new-password"
              />
              <p className="mt-1 text-xs text-zinc-500">密文入库后不可逆展示，列表仅显示前缀 +「已配置」。</p>
            </div>
            {keyForm.mode === "edit" && (
              <div>
                <label className={labelCls}>状态</label>
                <select className={selectCls} value={keyForm.status || "active"} onChange={(e) => setKeyForm({ ...keyForm, status: e.target.value })}>
                  <option value="active">启用</option>
                  <option value="disabled">禁用</option>
                </select>
              </div>
            )}
            <div>
              <label className={labelCls}>备注</label>
              <input className={inputCls} value={keyForm.remark || ""} onChange={(e) => setKeyForm({ ...keyForm, remark: e.target.value })} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className={btnCls} onClick={() => setKeyForm(null)}>取消</button>
              <button
                type="button"
                className={primaryBtnCls}
                disabled={busy || !keyForm.name || (keyForm.mode === "create" && !keyForm.apiKey)}
                onClick={() =>
                  submit(async () => {
                    const body: Record<string, unknown> = { name: keyForm.name?.trim(), remark: keyForm.remark || undefined };
                    if (keyForm.mode === "create") {
                      body.vendorId = keyForm.vendorId;
                      body.apiKey = keyForm.apiKey;
                    } else {
                      if (keyForm.apiKey) body.apiKey = keyForm.apiKey;
                      body.status = keyForm.status;
                    }
                    if (keyForm.mode === "create") {
                      await apiCall("/api/admin/models/keys", jsonInit("POST", body));
                    } else {
                      await apiCall(`/api/admin/models/keys/${keyForm.id}`, jsonInit("PUT", body));
                    }
                    flash("ok", "Key 已保存");
                    setKeyForm(null);
                    refreshCurrent();
                  })
                }
              >
                保存
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ─── 获取所有模型：选择入库弹层（批量勾选 + 类型/端点展示） ─── */}
      {fetchPreview && (
        <Modal title={`获取所有模型 · ${fetchPreview.vendorName}（选择入库）`} wide onClose={() => setFetchPreview(null)}>
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">
              上游共 {fetchPreview.total} 个模型：可入库候选 {fetchPreview.counts.candidates} / 已在库 {fetchPreview.counts.inDb} /
              已停用跳过 {fetchPreview.counts.skippedUnavailable}
              {fetchPreview.counts.toDeactivate > 0 && <>，确认入库时将同步标记下线 {fetchPreview.counts.toDeactivate} 个已失效模型</>}。
              仅勾选的模型会入库（已有模型不会被覆盖）。
            </p>
            {fetchPreview.candidates.length > 0 ? (
              <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-zinc-800">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className={thCls}>
                        <input
                          type="checkbox"
                          checked={fetchSel.length === fetchPreview.candidates.length}
                          onChange={() => setFetchSel(fetchSel.length === fetchPreview.candidates.length ? [] : fetchPreview.candidates.map((c) => c.name))}
                        />
                      </th>
                      <th className={thCls}>模型名称</th>
                      <th className={thCls}>类型</th>
                      <th className={thCls}>端点</th>
                      <th className={thCls}>归属</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fetchPreview.candidates.map((c) => (
                      <tr key={c.name} className="hover:bg-zinc-800/40">
                        <td className={tdCls}>
                          <input type="checkbox" checked={fetchSel.includes(c.name)} onChange={() => toggleFetchSel(c.name)} />
                        </td>
                        <td className={`${tdCls} max-w-[320px] truncate`}>{c.name}</td>
                        <td className={tdCls}>{c.endpointType}</td>
                        <td className={tdCls}>{c.path || "-"}</td>
                        <td className={tdCls}>{c.ownedBy || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="rounded-lg border border-zinc-800 bg-zinc-800/40 px-4 py-6 text-center text-sm text-zinc-500">
                无新增可用模型（均已在库或已停用）
              </p>
            )}
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-zinc-500">已选 {fetchSel.length} / {fetchPreview.candidates.length} 个候选模型</span>
              <div className="flex gap-2">
                <button type="button" className={btnCls} onClick={() => setFetchPreview(null)}>取消</button>
                <button
                  type="button"
                  className={primaryBtnCls}
                  disabled={busy || fetchSel.length === 0}
                  onClick={importSelectedModels}
                >
                  确定入库（{fetchSel.length}）
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* ─── 模型弹层 ─── */}
      {modelForm && (
        <Modal title={modelForm.mode === "create" ? "新建模型" : "编辑模型"} onClose={() => setModelForm(null)}>
          <div className="space-y-3">
            <div>
              <label className={labelCls}>厂商 *</label>
              <select className={selectCls} value={modelForm.vendorId || ""} onChange={(e) => setModelForm({ ...modelForm, vendorId: Number(e.target.value) })} disabled={modelForm.mode === "edit"}>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>上游模型名 *</label>
                <input className={inputCls} value={modelForm.name || ""} onChange={(e) => setModelForm({ ...modelForm, name: e.target.value })} placeholder="deepseek-chat" disabled={modelForm.mode === "edit"} />
              </div>
              <div>
                <label className={labelCls}>展示名 *</label>
                <input className={inputCls} value={modelForm.displayName || ""} onChange={(e) => setModelForm({ ...modelForm, displayName: e.target.value })} placeholder="DeepSeek 对话" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>端点类型</label>
                <select className={selectCls} value={modelForm.endpointType || "chat"} onChange={(e) => setModelForm({ ...modelForm, endpointType: e.target.value })}>
                  <option value="chat">chat</option>
                  <option value="image">image</option>
                  <option value="video">video</option>
                  <option value="audio">audio</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>状态（上下线）</label>
                <select className={selectCls} value={modelForm.status || "online"} onChange={(e) => setModelForm({ ...modelForm, status: e.target.value })}>
                  <option value="online">上线</option>
                  <option value="deprecated">弃用</option>
                  <option value="offline">下线</option>
                </select>
              </div>
            </div>
            {modelForm.mode === "create" && (
              <div>
                <label className={labelCls}>初始定价（可选，创建后可在详情里调价）</label>
                <div className="grid grid-cols-3 gap-3">
                  <input className={inputCls} type="number" step="any" min="0" placeholder="输入单价" value={modelForm.initInputPrice ?? 0} onChange={(e) => setModelForm({ ...modelForm, initInputPrice: Number(e.target.value) })} />
                  <input className={inputCls} type="number" step="any" min="0" placeholder="输出单价" value={modelForm.initOutputPrice ?? 0} onChange={(e) => setModelForm({ ...modelForm, initOutputPrice: Number(e.target.value) })} />
                  <input className={inputCls} type="number" min="1" placeholder="加价系数 bps" value={modelForm.initMultiplierBps ?? 150} onChange={(e) => setModelForm({ ...modelForm, initMultiplierBps: Number(e.target.value) })} />
                </div>
              </div>
            )}
            <div>
              <label className={labelCls}>备注</label>
              <input className={inputCls} value={modelForm.remark || ""} onChange={(e) => setModelForm({ ...modelForm, remark: e.target.value })} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className={btnCls} onClick={() => setModelForm(null)}>取消</button>
              <button
                type="button"
                className={primaryBtnCls}
                disabled={busy || !modelForm.vendorId || !modelForm.name || !modelForm.displayName}
                onClick={() =>
                  submit(async () => {
                    if (modelForm.mode === "create") {
                      const hasPrice = (modelForm.initInputPrice ?? 0) > 0 || (modelForm.initOutputPrice ?? 0) > 0;
                      await apiCall(
                        "/api/admin/models/models",
                        jsonInit("POST", {
                          vendorId: modelForm.vendorId,
                          name: modelForm.name?.trim(),
                          displayName: modelForm.displayName?.trim(),
                          endpointType: modelForm.endpointType || "chat",
                          status: modelForm.status || "online",
                          remark: modelForm.remark || undefined,
                          ...(hasPrice
                            ? {
                                pricing: {
                                  inputPrice: modelForm.initInputPrice ?? 0,
                                  outputPrice: modelForm.initOutputPrice ?? 0,
                                  multiplierBps: modelForm.initMultiplierBps ?? 150,
                                },
                              }
                            : {}),
                        })
                      );
                    } else {
                      await apiCall(
                        `/api/admin/models/models/${modelForm.id}`,
                        jsonInit("PUT", {
                          displayName: modelForm.displayName?.trim(),
                          endpointType: modelForm.endpointType,
                          status: modelForm.status,
                          remark: modelForm.remark || undefined,
                        })
                      );
                    }
                    flash("ok", "模型已保存");
                    setModelForm(null);
                    refreshCurrent();
                  })
                }
              >
                保存
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ─── 模型详情：调价历史 / 端点 / 定价试算 ─── */}
      {detail && (
        <Modal title={`模型详情：${detail.model.displayName}（${detail.model.name}）`} onClose={() => setDetail(null)} wide>
          <div className="space-y-5">
            {/* 当前定价 + 试算 */}
            <div className={cardCls}>
              <h4 className="mb-2 text-sm font-medium text-zinc-300">当前生效定价</h4>
              {detail.currentPricing ? (
                <p className="mb-3 text-sm text-zinc-400">
                  输入 {detail.currentPricing.inputPrice} / 输出 {detail.currentPricing.outputPrice}{" "}
                  {detail.currentPricing.currency}（每 {detail.currentPricing.meterBase} {detail.currentPricing.unit}），
                  汇率 1e8={detail.currentPricing.fxRateE8}，加价 {(detail.currentPricing.multiplierBps / 10000).toFixed(2)}x，
                  生效于 {new Date(detail.currentPricing.effectiveAt).toLocaleString("zh-CN")}
                </p>
              ) : (
                <p className="mb-3 text-sm text-amber-400">尚未定价，网关按最低 1 分兜底。</p>
              )}

              <h4 className="mb-2 text-sm font-medium text-zinc-300">定价试算</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>输入 Tokens</label>
                  <input className={inputCls} type="number" min="0" value={calc.promptTokens} onChange={(e) => setCalc({ ...calc, promptTokens: e.target.value })} />
                </div>
                <div>
                  <label className={labelCls}>输出 Tokens</label>
                  <input className={inputCls} type="number" min="0" value={calc.outputTokens} onChange={(e) => setCalc({ ...calc, outputTokens: e.target.value })} />
                </div>
              </div>
              <p className="mt-2 text-sm text-zinc-300">
                内部成本：<span className="text-sky-300">{calcCost} 毫积分（{(calcCost / 1000).toFixed(2)} 积分）</span>
                　用户标价：<span className="text-emerald-400">{calcCredits} 积分（ceil，最低 1 分）</span>
              </p>
              <div className="mt-3 flex items-end gap-3">
                <div className="flex-1">
                  <label className={labelCls}>成本换算预览：输入 costMilli（毫积分）</label>
                  <input className={inputCls} type="number" min="0" value={calc.costMilli} onChange={(e) => setCalc({ ...calc, costMilli: e.target.value })} />
                </div>
                <p className="pb-2 text-sm text-emerald-400">→ 标价 {manualCredits} 积分</p>
              </div>
            </div>

            {/* 调价历史 */}
            <div className={cardCls}>
              <h4 className="mb-2 text-sm font-medium text-zinc-300">调价历史（只增不改，按生效时间取最新）</h4>
              <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                <input className={inputCls} type="number" step="any" min="0" placeholder="输入单价" value={priceForm.inputPrice} onChange={(e) => setPriceForm({ ...priceForm, inputPrice: e.target.value })} />
                <input className={inputCls} type="number" step="any" min="0" placeholder="输出单价" value={priceForm.outputPrice} onChange={(e) => setPriceForm({ ...priceForm, outputPrice: e.target.value })} />
                <input className={inputCls} placeholder="币种" value={priceForm.currency} onChange={(e) => setPriceForm({ ...priceForm, currency: e.target.value })} />
                <input className={inputCls} type="number" min="1" placeholder="加价 bps（150=1.5x）" value={priceForm.multiplierBps} onChange={(e) => setPriceForm({ ...priceForm, multiplierBps: e.target.value })} />
                <input className={inputCls} type="datetime-local" value={priceForm.effectiveAt} onChange={(e) => setPriceForm({ ...priceForm, effectiveAt: e.target.value })} />
              </div>
              <div className="mb-3 flex items-center gap-3">
                <button type="button" className={primaryBtnCls} disabled={busy} onClick={savePricing}>
                  新增调价记录
                </button>
                <span className="text-xs text-zinc-500">生效时间留空 = 立即生效；旧记录保留可追溯</span>
              </div>
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={thCls}>生效时间</th>
                    <th className={thCls}>输入/输出单价</th>
                    <th className={thCls}>币种</th>
                    <th className={thCls}>计量基数</th>
                    <th className={thCls}>加价系数</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.pricings.map((p) => (
                    <tr key={p.id}>
                      <td className={tdCls}>{new Date(p.effectiveAt).toLocaleString("zh-CN")}</td>
                      <td className={tdCls}>{p.inputPrice} / {p.outputPrice}</td>
                      <td className={tdCls}>{p.currency}</td>
                      <td className={tdCls}>{p.meterBase} {p.unit}</td>
                      <td className={tdCls}>{(p.multiplierBps / 10000).toFixed(2)}x</td>
                    </tr>
                  ))}
                  {detail.pricings.length === 0 && (
                    <tr><td className={`${tdCls} text-center text-zinc-500`} colSpan={5}>暂无定价记录</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* 端点管理 */}
            <div className={cardCls}>
              <h4 className="mb-2 text-sm font-medium text-zinc-300">端点管理</h4>
              <div className="mb-3 space-y-2">
                {endpointDraft.map((e, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      className={inputCls}
                      value={e.path}
                      placeholder="chat_completions / image_generations / …"
                      onChange={(ev) => {
                        const next = [...endpointDraft];
                        next[i] = { ...next[i], path: ev.target.value };
                        setEndpointDraft(next);
                      }}
                    />
                    <label className="flex items-center gap-1 whitespace-nowrap text-xs text-zinc-400">
                      <input
                        type="checkbox"
                        checked={e.enabled}
                        onChange={(ev) => {
                          const next = [...endpointDraft];
                          next[i] = { ...next[i], enabled: ev.target.checked };
                          setEndpointDraft(next);
                        }}
                      />
                      启用
                    </label>
                    <button
                      type="button"
                      className={dangerBtnCls}
                      onClick={() => setEndpointDraft(endpointDraft.filter((_, j) => j !== i))}
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button type="button" className={btnCls} onClick={() => setEndpointDraft([...endpointDraft, { path: "", enabled: true }])}>
                  添加端点
                </button>
                <button type="button" className={primaryBtnCls} disabled={busy} onClick={saveEndpoints}>
                  保存端点
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
