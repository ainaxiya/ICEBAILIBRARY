"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pricingUnitSuffix } from "@/lib/gateway/pricing";

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
  weight: number;
  maintainUntil: string | null;
  maintaining?: boolean;
  health?: {
    state: "closed" | "open" | "half-open";
    samples: number;
    failRate: number;
    decryptFailures?: number;
    lastDecryptFailureAt?: number | null;
  };
  remark: string | null;
  tags?: string[];
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
  // v0.96 直观定价：会员价按输入/输出直接填（积分/计量基数）
  memberInputPrice: number | null;
  memberOutputPrice: number | null;
  // 计费档位键（'' = 通用）
  variant?: string;
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
  // 高级配置（JSON 文本）
  advancedConfig: string | null;
  endpoints: EndpointRow[];
  currentPricing: PricingRow | null;
  pricePreview: { unit: string; costInput: number; costOutput: number; memberInput: number; memberOutput: number } | null;
};

type ModelDetail = {
  model: { id: number; name: string; displayName: string; endpointType: string; status: string; remark: string | null; vendorName: string };
  currentPricing: PricingRow | null;
  pricings: PricingRow[];
  endpoints: EndpointRow[];
};

// 「获取所有模型」预览条目（上游全量模型：可用性 / 是否已在库 / 是否可勾选入库）
type FetchItem = {
  name: string;
  endpointType: string;
  path: string | null;
  shutdownDate: string | null;
  ownedBy: string | null;
  status: string | null;
  available: boolean;
  unavailableReason: "status_unavailable" | "retiring" | "shutdown" | "internal" | null;
  inDb: boolean;
  dbStatus: string | null;
  videoParams: Record<string, unknown> | null;
};
// 「获取原价」预览（/models/pricing 按已入库模型 ID 匹配）
type PriceFetchEntry = {
  model: string;
  input: number | null;
  output: number | null;
  currency: string;
  meterBase: number;
  unit: string;
  state: "fill" | "hasPricing" | "notInDb";
};
type PriceFetch = {
  keyId: number;
  keyName: string;
  vendorName: string;
  total: number;
  matched: number;
  fillable: number;
  entries: PriceFetchEntry[];
};
type FetchPreview = {
  keyId: number;
  vendorName: string;
  total: number;
  counts: { candidates: number; available: number; inDb: number; skippedUnavailable: number; toDeactivate: number };
  items: FetchItem[];
  // b15：上游变更检测（新增 / 下线 / 恢复 / 参数变化）
  diff?: {
    added: string[];
    toOffline: string[];
    toRestore: string[];
    paramChanged: string[];
    counts: { added: number; toOffline: number; toRestore: number; paramChanged: number };
  };
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

// 积分展示：成本价可带小数（≤2 位），整数不带小数
const fmtCredits = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

// 调价历史每页条数
const PRICE_PAGE_SIZE = 5;

// 计价单位 → 计费口径（保存时统一换算成 unit + meterBase）
const PRICE_UNIT_MAP: Record<string, { unit: string; meterBase: number }> = {
  image: { unit: "image", meterBase: 1 },
  video_second: { unit: "video_second", meterBase: 1 },
  audio_second: { unit: "audio_second", meterBase: 1 },
  char: { unit: "char", meterBase: 1_000 },
  request: { unit: "request", meterBase: 1 },
  "token-1m": { unit: "token", meterBase: 1_000_000 },
  "token-1k": { unit: "token", meterBase: 1_000 },
};

// v1.0.98 视频分辨率档位（与网关 variant 键一致）：n=无视频输入，v=含参考视频
const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "4K"] as const;
const VIDEO_TIER_RE = /^(480p|720p|1080p|4K):[nv]$/;

// b19 单模型快速定价抽屉：倍率 / 按次 / 当前缓存价收敛一表单，输入即折算
type QuickPriceForm = {
  model: ModelRow;
  unit: string;
  currency: string;
  costInput: string;
  costOutput: string;
  // multiplier = 按倍率换算会员价；member = 直接填会员价，反推倍率
  mode: "multiplier" | "member";
  multiplier: string;
  memberInput: string;
  memberOutput: string;
  effectiveAt: string;
};

// 端点接口选项（「模型设置」新增端点下拉）：中文名 + 接口名
const ENDPOINT_OPTIONS: { value: string; label: string }[] = [
  { value: "chat_completions", label: "对话 chat_completions" },
  { value: "image_generations", label: "生图 image_generations" },
  { value: "video_generations", label: "视频 video_generations" },
  { value: "embeddings", label: "向量 embeddings" },
  { value: "audio_transcriptions", label: "音频转写 audio_transcriptions" },
  { value: "audio_speech", label: "语音合成 audio_speech" },
  { value: "rerank", label: "重排 rerank" },
];

// v0.96 计量单位文案：token 模型按 1M/1K TOKEN，媒体模型按 张/视频秒/次
function unitLabel(p: { meterBase: number; unit: string } | null, endpointType?: string): string {
  if (p) {
    if (p.unit === "token") return p.meterBase >= 1_000_000 ? "1M TOKEN" : p.meterBase >= 1_000 ? "1K TOKEN" : `${p.meterBase} TOKEN`;
    if (p.unit === "image") return "张";
    if (p.unit === "video_second") return "视频秒";
    if (p.unit === "audio_second") return "音频秒";
    if (p.unit === "char") return "千字符";
    return "次";
  }
  return endpointType === "image" ? "张" : endpointType === "video" ? "视频秒" : "1M TOKEN";
}

// 成本积分（每计量基数，可带小数）= 单价 × 汇率 × 100（1 元 = 100 积分）
function costCreditsPerUnit(p: PricingRow, side: "input" | "output"): number {
  return (side === "input" ? p.inputPrice : p.outputPrice) * (p.fxRateE8 / 1e8) * 100;
}

// 会员积分（每计量基数）：优先直接填的会员价，否则 成本积分 × 兜底系数
function memberCreditsPerUnit(p: PricingRow, side: "input" | "output"): number {
  const direct = side === "input" ? p.memberInputPrice : p.memberOutputPrice;
  return direct != null ? direct : costCreditsPerUnit(p, side) * (p.multiplierBps / 10000);
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "online" || status === "active"
      ? "bg-emerald-500/15 text-emerald-400"
      : status === "deprecated"
        ? "bg-amber-500/15 text-amber-400"
        : "bg-zinc-700/50 text-zinc-400";
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${cls}`}>{STATUS_LABEL[status] || status}</span>
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
  // 请求去重：相同写请求在未返回前复用同一个 Promise，避免连点造成重复落库
  const inflightRef = useRef<Map<string, Promise<any>>>(new Map());
  // 调价提交中标记：按钮禁用 + 同 tick 连点拦截（state 更新是异步的，ref 才是硬闸）
  const savingPriceRef = useRef(false);
  const [savingPrice, setSavingPrice] = useState(false);

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  // o4：加密密钥来源状态（未配置独立 STORAGE_KEY_SECRET 时告警）
  const [keySecurity, setKeySecurity] = useState<{ configured: boolean; usingJwtFallback: boolean } | null>(null);
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
    | (Partial<ModelRow> & {
        mode: "create" | "edit";
        advancedConfig?: string | null;
        // v0.96 直观定价：成本价（供应商币种）+ 会员价（积分）
        initCostInput?: number;
        initCostOutput?: number;
        initCurrency?: string;
        initMemberInput?: number;
        initMemberOutput?: number;
      })
    | null
  >(null);

  // 模型详情（价格调整：成本/出售价格、调价历史）
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [endpointDraft, setEndpointDraft] = useState<EndpointRow[]>([]);
  // 模型设置里「新增端点」下拉选中的接口
  const [endpointPick, setEndpointPick] = useState("");
  // v0.96 直观定价：成本价（供应商币种）+ 会员价（积分）按输入/输出分开填
  // v0.113 计价单位可选（按张/按秒/按次/按 1M|1K tokens）；空 = 继承当前口径
  const [priceForm, setPriceForm] = useState({
    costInput: "0",
    costOutput: "0",
    currency: "CNY",
    memberInput: "",
    memberOutput: "",
    effectiveAt: "",
    unit: "",
    // v1.0.98 视频恢复分辨率档位：key = `${480p|720p|1080p|4K}:${n|v}`
    tierTab: "n" as "n" | "v",
    tiers: {} as Record<string, { cost: string; member: string }>,
  });

  // 「获取所有模型」选择入库弹层（预览上游全量模型 + 按可用性筛选勾选）
  const [fetchPreview, setFetchPreview] = useState<FetchPreview | null>(null);
  const [fetchSel, setFetchSel] = useState<string[]>([]);
  // b15：可恢复上线的已下线模型
  const [fetchRestoreSel, setFetchRestoreSel] = useState<string[]>([]);
  // 可用性筛选：available=可用且未入库 / unavailable=上游不可用 / inDb=已在库 / all=全部
  const [fetchFilter, setFetchFilter] = useState<"available" | "unavailable" | "inDb" | "recover" | "all">("available");
  // ─── 获取原价：/models/pricing 按已入库模型 ID 匹配（须先「获取所有模型」入库） ───
  const [priceFetch, setPriceFetch] = useState<PriceFetch | null>(null);
  // v0.96：新建 KEY 的可选自动获取参数（聚合 AI）
  const [keyAutoFetch, setKeyAutoFetch] = useState(true);
  const [keyAutoPricing, setKeyAutoPricing] = useState(true);
  // 汇率表（币种 → RMB）：模型管理里所有汇率统一引用，只读；改汇率走「汇率管理」
  const [fxRates, setFxRates] = useState<{ currency: string; rate: number }[]>([]);
  const [fxModal, setFxModal] = useState(false);
  const [fxDraft, setFxDraft] = useState<{ currency: string; rate: string }[]>([]);
  // P5 渠道运营：维护窗口菜单展开中的 Key ID
  const [maintainMenu, setMaintainMenu] = useState<number | null>(null);
  // 调价历史分页 + 成本试算（利润积分）结果
  const [pricePage, setPricePage] = useState(1);
  const [profit, setProfit] = useState<{ in: number; out: number } | null>(null);

  // b19：单模型快速定价抽屉
  const [quick, setQuick] = useState<QuickPriceForm | null>(null);
  const [quickSaving, setQuickSaving] = useState(false);

  const flash = (kind: "ok" | "err", text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 3000);
  };

  // P5 渠道运营：Key 健康徽标（解密失败 > 维护中 > 熔断 > 半开探测 > 健康）
  const keyHealthBadge = (k: KeyRow) => {
    const df = k.health?.decryptFailures ?? 0;
    if (df > 0) {
      const at = k.health?.lastDecryptFailureAt;
      return (
        <span
          className="rounded bg-red-500/15 px-1.5 py-0.5 text-xs text-red-400"
          title={`解密失败 ${df} 次${at ? `，最近 ${new Date(at).toLocaleString()}` : ""}。请确认 STORAGE_KEY_SECRET 未变更；若已轮换，需在后台重新保存该 Key 的明文。`}
        >
          解密失败 {df}
        </span>
      );
    }
    if (k.maintaining) {
      return (
        <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-xs text-orange-400" title={`维护至 ${k.maintainUntil ? new Date(k.maintainUntil).toLocaleString() : ""}，期间不参与选路`}>
          维护中
        </span>
      );
    }
    const h = k.health;
    if (!h || h.state === "closed") {
      return (
        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-400" title={`样本 ${h?.samples ?? 0} · 失败率 ${h?.failRate ?? 0}%`}>
          健康
        </span>
      );
    }
    if (h.state === "open") {
      return (
        <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-xs text-red-400" title={`样本 ${h.samples} · 失败率 ${h.failRate}% · 冷却 60s 后放行半开探测`}>
          熔断 {h.failRate}%
        </span>
      );
    }
    return (
      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-400" title={`样本 ${h.samples} · 失败率 ${h.failRate}% · 放行探测中`}>
        半开探测
      </span>
    );
  };

  // P5 维护窗口：设置/解除（maintainMinutes>0 进入维护，0 解除）
  const setMaintain = (id: number, minutes: number) =>
    submit(async () => {
      await apiCall(`/api/admin/models/keys/${id}`, jsonInit("PUT", { maintainMinutes: minutes }));
      flash("ok", minutes > 0 ? `Key 已进入维护 ${minutes} 分钟（期间不参与选路）` : "已解除维护");
      setMaintainMenu(null);
      loadKeys();
    });

  const apiCall = async (url: string, init?: RequestInit) => {
    const method = (init?.method || "GET").toUpperCase();
    // 只对写请求去重：方法 + 路径 + 请求体完全相同即视为同一次提交
    const key =
      method === "GET" ? "" : `${method} ${url} ${typeof init?.body === "string" ? init.body : ""}`;
    const running = key ? inflightRef.current.get(key) : undefined;
    if (running) return running;

    const run = (async () => {
      const r = await fetch(url, init);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "请求失败");
      return d;
    })();

    if (key) {
      inflightRef.current.set(key, run);
      const done = () => inflightRef.current.delete(key);
      run.then(done, done);
    }
    return run;
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
      setKeySecurity(d.keySecurity || null);
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

  const loadFx = useCallback(async () => {
    try {
      const d = await apiCall("/api/admin/models/fx");
      setFxRates(d.rates || []);
    } catch {
      /* 静默 */
    }
  }, []);

  useEffect(() => {
    loadVendors();
    loadKeys();
    loadModels();
    loadFx();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 取汇率（CNY 固定 1；其他币种查汇率表，未配置回退 7.15）——模型管理内所有汇率只读引用这里
  const fxOf = (currency: string) => {
    if (currency.toUpperCase() === "CNY") return 1;
    const r = fxRates.find((f) => f.currency === currency.toUpperCase());
    return r ? r.rate : 7.15;
  };

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

  // ─── 获取所有模型：拉取上游模型清单预览（/models + /models?type=video，不含价格），弹层筛选勾选入库 ───
  const fetchModelsOfKey = async (k: KeyRow) => {
    setBusy(true);
    try {
      const d = await apiCall(`/api/admin/models/keys/${k.id}/fetch-models`);
      const items: FetchItem[] = d.items || [];
      setFetchPreview({
        keyId: k.id,
        vendorName: k.vendorName,
        total: d.total,
        counts: d.counts,
        items,
        diff: d.diff,
      });
      // 默认勾选「可用且未入库」的模型；若没有新候选（都已入库/不可用），默认展示全部，避免弹层看起来是空的
      setFetchSel(items.filter((i) => i.available && !i.inDb).map((i) => i.name));
      setFetchRestoreSel(d.diff?.toRestore || []);
      setFetchFilter(items.some((i) => i.available && !i.inDb) ? "available" : "all");
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 获取原价预览：只按已入库模型匹配价格（不入库）
  const fetchPricesOfKey = async (k: KeyRow) => {
    setBusy(true);
    try {
      const d = await apiCall(`/api/admin/models/keys/${k.id}/fetch-models?mode=pricing`);
      setPriceFetch({
        keyId: k.id,
        keyName: k.name,
        vendorName: k.vendorName,
        total: d.total,
        matched: d.matched,
        fillable: d.fillable,
        entries: d.entries || [],
      });
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 填入价格：仅补「尚无定价」的已入库模型（不覆盖已有调价）
  const applyFetchedPrices = async () => {
    if (!priceFetch || busy) return;
    await submit(async () => {
      const d = await apiCall(
        `/api/admin/models/keys/${priceFetch.keyId}/fetch-models`,
        jsonInit("POST", { mode: "pricing" })
      );
      flash("ok", `已填入成本价 ${d.filled} 条（已有定价跳过 ${d.skippedHasPricing} / 未入库未匹配 ${d.noMatch}）`);
      setPriceFetch(null);
      refreshCurrent();
    });
  };

  // 勾选入库：创建勾选候选 + 恢复勾选的已下线模型；同步已在库模型可用性
  const importSelectedModels = async () => {
    if (!fetchPreview || (fetchSel.length === 0 && fetchRestoreSel.length === 0) || busy) return;
    await submit(async () => {
      const d = await apiCall(
        `/api/admin/models/keys/${fetchPreview.keyId}/fetch-models`,
        jsonInit("POST", {
          names: fetchSel,
          restoreNames: fetchRestoreSel,
        })
      );
      flash(
        "ok",
        `已入库 ${d.created} 个模型（恢复上线 ${d.restored || 0} / 标记下线 ${d.deactivated} / 跳过已停用 ${d.skipped}），价格可再用「获取原价」补`
      );
      setFetchPreview(null);
      refreshCurrent();
    });
  };

  const toggleFetchSel = (name: string) =>
    setFetchSel((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));
  const toggleRestoreSel = (name: string) =>
    setFetchRestoreSel((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));

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

  // ─── b14 渠道批量运营：测活 / 启停 / 打标 / 删除全部禁用 / 一致性修复 ───
  const runKeyBatch = async (
    action: "test" | "enable" | "disable" | "tag" | "delete-disabled" | "repair",
    extra?: { tagOp?: "add" | "remove" | "replace"; tags?: string[] }
  ) => {
    if (busy) return;
    if (action !== "delete-disabled" && action !== "repair" && sel.length === 0) return;
    if (action === "delete-disabled" && !confirm("确定删除全部已禁用的 Key 吗？此操作不可恢复。")) return;
    if (action === "repair" && !confirm("确定对全部 Key 执行一致性修复（非法状态 / 权重<1 / 过期维护窗口）吗？")) return;
    await submit(async () => {
      const d = await apiCall(
        "/api/admin/models/keys/batch",
        jsonInit("POST", {
          action,
          ids: action === "delete-disabled" || action === "repair" ? undefined : sel,
          ...(extra ?? {}),
        })
      );
      if (action === "test") {
        const failed = (d.items || [])
          .filter((r: { ok: boolean }) => !r.ok)
          .slice(0, 3)
          .map((r: { name: string; error: string | null }) => `${r.name}（${r.error || "失败"}）`);
        flash("ok", `测活完成：可用 ${d.passed} / 失败 ${d.failed}${failed.length ? `；${failed.join("、")}` : ""}`);
      } else if (action === "delete-disabled") {
        flash("ok", `已删除 ${d.deleted} 个禁用 Key`);
      } else if (action === "repair") {
        flash("ok", `一致性修复：更新 ${d.changed} 个 Key（状态 ${d.counts?.status ?? 0} / 权重 ${d.counts?.weight ?? 0} / 维护窗口 ${d.counts?.maintainUntil ?? 0}）`);
      } else if (action === "tag") {
        flash("ok", `已打标 ${d.affected} 个 Key`);
      } else {
        flash("ok", `已${action === "enable" ? "启用" : "禁用"} ${d.affected} 项`);
      }
      setSel([]);
      refreshCurrent();
    });
  };

  const promptKeyTag = (op: "add" | "remove") => {
    if (sel.length === 0) return;
    const raw = window.prompt(
      op === "add" ? "输入要添加的标签（逗号分隔，最多 20 个）" : "输入要移除的标签（逗号分隔）"
    );
    if (!raw || !raw.trim()) return;
    const tags = raw
      .split(/[,，、\n\r]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length === 0) return;
    runKeyBatch("tag", { tagOp: op, tags });
  };

  // ─── 模型详情 ───
  const openDetail = async (id: number) => {
    await submit(async () => {
      const d = await apiCall(`/api/admin/models/models/${id}`);
      setDetail(d);
      setPricePage(1);
      setProfit(null);
      const cur = d.currentPricing as PricingRow | null;
      const fx = cur ? cur.fxRateE8 / 1e8 : 1;
      // 成本积分（每计量基数）= 单价 × 汇率 × 100；会员价默认建议 = 成本积分 × 1.5
      const suggestMember = (price: number) => String(Math.max(1, Math.ceil(price * fx * 100 * 1.5)));
      // 生效时间默认当前时间（可改）
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const nowLocal = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      // 视频统一秒价：只取通用行（variant=""）；历史分辨率档位仅保留为记录，不再回填/参与计费
      const videoEndpoint = d.model.endpointType === "video";
      const videoGeneric = videoEndpoint
        ? ((d.pricings || []).find(
            (p: PricingRow) => p.unit === "video_second" && (p.variant ?? "") === ""
          ) as PricingRow | undefined) ?? null
        : null;
      const formBase = videoEndpoint ? videoGeneric : cur;
      // v1.0.98 分辨率档位回填：pricings 已按 effectiveAt 倒序，每个 variant 取第一条
      const tiers: Record<string, { cost: string; member: string }> = {};
      if (videoEndpoint) {
        for (const p of (d.pricings || []) as PricingRow[]) {
          if (p.unit !== "video_second") continue;
          const v = p.variant ?? "";
          if (!VIDEO_TIER_RE.test(v) || tiers[v]) continue;
          tiers[v] = {
            cost: Number(p.inputPrice) > 0 ? String(p.inputPrice) : "",
            member:
              p.memberInputPrice != null && Number(p.memberInputPrice) > 0
                ? String(p.memberInputPrice)
                : "",
          };
        }
      }
      setPriceForm({
        costInput: videoEndpoint
          ? videoGeneric && Number(videoGeneric.inputPrice) > 0
            ? String(videoGeneric.inputPrice)
            : ""
          : String(cur?.inputPrice ?? 0),
        costOutput: videoEndpoint ? "" : String(cur?.outputPrice ?? 0),
        currency: formBase?.currency || "CNY",
        memberInput: videoEndpoint
          ? videoGeneric?.memberInputPrice != null
            ? String(videoGeneric.memberInputPrice)
            : ""
          : cur
            ? cur.memberInputPrice != null
              ? String(cur.memberInputPrice)
              : suggestMember(cur.inputPrice)
            : "",
        memberOutput: videoEndpoint
          ? ""
          : cur
            ? cur.memberOutputPrice != null
              ? String(cur.memberOutputPrice)
              : suggestMember(cur.outputPrice)
            : "",
        effectiveAt: nowLocal,
        // 计价单位：视频端点默认「按秒」（下拉可改）；其余有历史按历史，未定价按端点类型
        unit: videoEndpoint
          ? "video_second"
          : cur
            ? cur.unit === "token"
              ? cur.meterBase >= 1_000_000
                ? "token-1m"
                : "token-1k"
              : cur.unit
            : d.model.endpointType === "image"
              ? "image"
              : "token-1m",
        tierTab: "n",
        tiers,
      });
    });
  };

  const savePricing = async () => {
    if (!detail || savingPriceRef.current) return;
    savingPriceRef.current = true;
    setSavingPrice(true);
    try {
      await submit(async () => {
        // 成本价（供应商币种/计量基数）；汇率取汇率表快照换算 RMB 计费
        const currency = (priceForm.currency || "CNY").toUpperCase();
        const fx = fxOf(currency);
        const costIn = Number(priceForm.costInput) || 0;
        const costOut = Number(priceForm.costOutput) || 0;
        const memberIn = priceForm.memberInput.trim() === "" ? null : Math.max(0, Number(priceForm.memberInput) || 0);
        const memberOut = priceForm.memberOutput.trim() === "" ? null : Math.max(0, Number(priceForm.memberOutput) || 0);
        // 兼容旧计费兜底系数 = 会员积分合计 ÷ 成本积分合计（无历史时 1.5x）
        const costCreditsSum = (costIn + costOut) * fx * 100;
        const memberSum = (memberIn ?? 0) + (memberOut ?? 0);
        const multiplierBps =
          costCreditsSum > 0 && memberSum > 0
            ? Math.max(1, Math.min(100_000, Math.round((memberSum / costCreditsSum) * 10_000)))
            : (cur?.multiplierBps ?? 15000);
        // 计价单位（选择后连同计量基数一起写入；空 = 继承历史口径）
        const picked = PRICE_UNIT_MAP[priceForm.unit];
        const endpoint = `/api/admin/models/models/${detail.model.id}/pricing`;
        const effectiveAt = priceForm.effectiveAt
          ? new Date(priceForm.effectiveAt).toISOString()
          : undefined;
        if (priceForm.unit === "video_second") {
          // 视频秒价：通用行（variant=""）＝统一秒价；档位行（如 720p:n）优先。
          // 档位填价按档位计费，档位留空（写 0/null）回退统一秒价；两者全空 = 未定价。
          const costRaw = priceForm.costInput.trim();
          const memberRaw = priceForm.memberInput.trim();
          const videoCost = costRaw === "" ? 0 : Math.max(0, Number(costRaw) || 0);
          const videoMember = memberRaw === "" ? null : Math.max(0, Number(memberRaw) || 0);
          const videoCostCredits = videoCost * fx * 100;
          const videoMultiplierBps =
            videoMember != null && videoMember > 0 && videoCostCredits > 0
              ? Math.max(1, Math.min(100_000, Math.round((videoMember / videoCostCredits) * 10_000)))
              : (cur?.multiplierBps ?? 15000);
          const common = {
            outputPrice: 0,
            currency,
            fxRateE8: Math.round(fx * 1e8),
            unit: "video_second",
            meterBase: 1,
            ...(effectiveAt ? { effectiveAt } : {}),
          };
          const rows: Record<string, unknown>[] = [
            {
              ...common,
              inputPrice: videoCost,
              multiplierBps: videoMultiplierBps,
              memberInputPrice: videoMember,
              memberOutputPrice: null,
              variant: "",
            },
          ];
          // 已有档位（pricings 倒序，每个 variant 取最新一条）用于判断是否真的改动
          const baseTiers = new Map<string, PricingRow>();
          for (const p of detail.pricings) {
            if (p.unit !== "video_second") continue;
            const v = p.variant ?? "";
            if (!VIDEO_TIER_RE.test(v) || baseTiers.has(v)) continue;
            baseTiers.set(v, p);
          }
          const allKeys = new Set<string>([...baseTiers.keys(), ...Object.keys(priceForm.tiers)]);
          for (const key of allKeys) {
            const t = priceForm.tiers[key] ?? { cost: "", member: "" };
            const cost = t.cost.trim() === "" ? 0 : Math.max(0, Number(t.cost) || 0);
            const member = t.member.trim() === "" ? null : Math.max(0, Number(t.member) || 0);
            const prev = baseTiers.get(key);
            const prevCost = prev ? Math.max(0, Number(prev.inputPrice) || 0) : 0;
            const prevMember =
              prev?.memberInputPrice != null && Number(prev.memberInputPrice) > 0
                ? Number(prev.memberInputPrice)
                : null;
            // 新档位全空不落库；已有档位改为全空需写 0/null 覆盖，才能回退统一秒价
            if (!prev && cost === 0 && member == null) continue;
            if (prev && cost === prevCost && member === prevMember) continue;
            const credits = cost * fx * 100;
            const mult =
              member != null && member > 0 && credits > 0
                ? Math.max(1, Math.min(100_000, Math.round((member / credits) * 10_000)))
                : videoMultiplierBps;
            rows.push({
              ...common,
              inputPrice: cost,
              multiplierBps: mult,
              memberInputPrice: member,
              memberOutputPrice: null,
              variant: key,
            });
          }
          await apiCall(endpoint, jsonInit("POST", { rows }));
        } else {
          await apiCall(
            endpoint,
            jsonInit("POST", {
              inputPrice: costIn,
              outputPrice: costOut,
              currency,
              fxRateE8: Math.round(fx * 1e8),
              multiplierBps,
              memberInputPrice: memberIn,
              memberOutputPrice: memberOut,
              // 档位机制只服务「按视频秒」；其他单位一律写通用键
              variant: "",
              ...(picked ? { unit: picked.unit, meterBase: picked.meterBase } : {}),
              ...(effectiveAt ? { effectiveAt } : {}),
            })
          );
        }
        flash("ok", "已确认调价（历史保留）");
        await openDetail(detail.model.id);
      });
    } finally {
      savingPriceRef.current = false;
      setSavingPrice(false);
    }
  };

  // ─── b19 单模型快速定价抽屉 ───
  const openQuick = (m: ModelRow) => {
    const cur = m.currentPricing;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const nowLocal = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const unit = cur
      ? cur.unit === "token"
        ? cur.meterBase >= 1_000_000
          ? "token-1m"
          : "token-1k"
        : cur.unit
      : m.endpointType === "image"
        ? "image"
        : m.endpointType === "video"
          ? "video_second"
          : "token-1m";
    const fx = cur ? cur.fxRateE8 / 1e8 : 1;
    const suggest = (price: number) => String(Math.max(1, Math.ceil(price * fx * 100 * 1.5)));
    setQuick({
      model: m,
      unit,
      currency: cur?.currency || "CNY",
      costInput: String(cur?.inputPrice ?? 0),
      costOutput: String(cur?.outputPrice ?? 0),
      mode: "multiplier",
      multiplier: ((cur?.multiplierBps || 15000) / 10000).toFixed(2),
      memberInput: cur?.memberInputPrice != null ? String(cur.memberInputPrice) : cur ? suggest(cur.inputPrice) : "",
      memberOutput: cur?.memberOutputPrice != null ? String(cur.memberOutputPrice) : cur ? suggest(cur.outputPrice) : "",
      effectiveAt: nowLocal,
    });
  };

  // 输入即折算：成本积分 = 单价 × 汇率 × 100；倍率模式算会员价，会员价模式反推倍率
  const quickFx = quick ? fxOf(quick.currency) : 1;
  const qCostIn = (Number(quick?.costInput) || 0) * quickFx * 100;
  const qCostOut = (Number(quick?.costOutput) || 0) * quickFx * 100;
  const qMultiplierInput = Math.max(0, Number(quick?.multiplier) || 0);
  const qMemberIn = quick
    ? quick.mode === "multiplier"
      ? qCostIn > 0
        ? Math.max(1, Math.ceil(qCostIn * qMultiplierInput))
        : 0
      : Math.max(0, Number(quick.memberInput) || 0)
    : 0;
  const qMemberOut = quick
    ? quick.mode === "multiplier"
      ? qCostOut > 0
        ? Math.max(1, Math.ceil(qCostOut * qMultiplierInput))
        : 0
      : Math.max(0, Number(quick.memberOutput) || 0)
    : 0;
  const qSumCost = qCostIn + qCostOut;
  const qSumMember = qMemberIn + qMemberOut;
  const qMultiplier =
    quick?.mode === "multiplier" ? qMultiplierInput : qSumCost > 0 ? qSumMember / qSumCost : 0;
  const quickUnitShort = !quick
    ? ""
    : quick.unit === "token-1m"
      ? "1M TOKEN"
      : quick.unit === "token-1k"
        ? "1K TOKEN"
        : quick.unit === "image"
          ? "张"
          : quick.unit === "video_second"
            ? "视频秒"
            : quick.unit === "audio_second"
              ? "音频秒"
              : quick.unit === "char"
                ? "千字符"
                : "次";
  const qCur = quick?.model.currentPricing || null;
  const qCurMemberIn = qCur ? memberCreditsPerUnit(qCur, "input") : 0;
  const qCurMemberOut = qCur ? memberCreditsPerUnit(qCur, "output") : 0;

  const saveQuick = async () => {
    if (!quick || quickSaving) return;
    if (quick.unit === "video_second") {
      flash("err", "视频秒价请用「价格调整」填写（统一秒价 + 分辨率档位）");
      return;
    }
    setQuickSaving(true);
    try {
      const model = quick.model;
      const currency = (quick.currency || "CNY").toUpperCase();
      const fx = fxOf(currency);
      const costIn = Number(quick.costInput) || 0;
      const costOut = Number(quick.costOutput) || 0;
      const memberIn =
        quick.mode === "multiplier"
          ? costIn * fx * 100 > 0
            ? Math.max(1, Math.ceil(costIn * fx * 100 * qMultiplierInput))
            : null
          : quick.memberInput.trim() === ""
            ? null
            : Math.max(0, Number(quick.memberInput) || 0);
      const memberOut =
        quick.mode === "multiplier"
          ? costOut * fx * 100 > 0
            ? Math.max(1, Math.ceil(costOut * fx * 100 * qMultiplierInput))
            : null
          : quick.memberOutput.trim() === ""
            ? null
            : Math.max(0, Number(quick.memberOutput) || 0);
      const costCreditsSum = (costIn + costOut) * fx * 100;
      const memberSum = (memberIn ?? 0) + (memberOut ?? 0);
      const multiplierBps =
        quick.mode === "multiplier" && qMultiplierInput > 0
          ? Math.max(1, Math.min(100_000, Math.round(qMultiplierInput * 10_000)))
          : costCreditsSum > 0 && memberSum > 0
            ? Math.max(1, Math.min(100_000, Math.round((memberSum / costCreditsSum) * 10_000)))
            : 15000;
      const picked = PRICE_UNIT_MAP[quick.unit] || PRICE_UNIT_MAP["token-1m"];
      const effectiveAt = quick.effectiveAt ? new Date(quick.effectiveAt).toISOString() : undefined;
      await apiCall(
        `/api/admin/models/models/${model.id}/pricing`,
        jsonInit("POST", {
          inputPrice: costIn,
          outputPrice: costOut,
          currency,
          fxRateE8: Math.round(fx * 1e8),
          multiplierBps,
          memberInputPrice: memberIn,
          memberOutputPrice: memberOut,
          variant: "",
          unit: picked.unit,
          meterBase: picked.meterBase,
          ...(effectiveAt ? { effectiveAt } : {}),
        })
      );
      flash("ok", `已确认调价：${model.displayName}`);
      setQuick(null);
      refreshCurrent();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "调价失败");
    } finally {
      setQuickSaving(false);
    }
  };

  // 保存端点（模型设置弹层用）
  const saveEndpointsFor = async (modelId: number, draft: EndpointRow[]) => {
    await apiCall(
      `/api/admin/models/models/${modelId}/endpoints`,
      jsonInit("PUT", {
        endpoints: draft
          .filter((e) => e.path.trim())
          .map((e) => ({ path: e.path.trim(), enabled: e.enabled })),
      })
    );
  };

  const cur = detail?.currentPricing || null;
  // 调价表单实时预览：成本积分 = 成本价 × 汇率 × 100（汇率取汇率表）
  const pfFx = fxOf(priceForm.currency);
  const pfCostIn = (Number(priceForm.costInput) || 0) * pfFx * 100;
  const pfCostOut = (Number(priceForm.costOutput) || 0) * pfFx * 100;
  // 成本试算：每计量基数（chat 即 1M TOKEN）利润积分 = 出售积分 − 成本积分（未填出售价按兜底 1.5x）
  const runProfit = () => {
    const saleIn = priceForm.memberInput.trim() === "" ? pfCostIn * 1.5 : Number(priceForm.memberInput) || 0;
    const saleOut = priceForm.memberOutput.trim() === "" ? pfCostOut * 1.5 : Number(priceForm.memberOutput) || 0;
    setProfit({ in: saleIn - pfCostIn, out: saleOut - pfCostOut });
  };

  // 计量短标签（成本价输入框「输入1M ￥」用）：优先调价表单选中的单位（v0.113），
  // 否则当前生效定价；未定价按端点类型（video→次兜底，可在计价单位里选按秒）
  const unitShort = (() => {
    const u = priceForm.unit;
    if (u === "token-1m") return "1M";
    if (u === "token-1k") return "1K";
    if (u === "image") return "张";
    if (u === "video_second") return "视频秒";
    if (u === "audio_second") return "音频秒";
    if (u === "char") return "千字符";
    if (u === "request") return "次";
    return cur
      ? cur.unit === "token"
        ? cur.meterBase >= 1_000_000
          ? "1M"
          : cur.meterBase >= 1_000
            ? "1K"
            : `${cur.meterBase}`
        : cur.unit === "image"
          ? "张"
          : cur.unit === "video_second"
            ? "视频秒"
            : cur.unit === "audio_second"
              ? "音频秒"
              : cur.unit === "char"
                ? "千字符"
                : "次"
      : detail?.model.endpointType === "image"
        ? "张"
        : detail?.model.endpointType === "video"
          ? "视频秒"
          : "1M";
  })();

  const isVideoUnit = priceForm.unit === "video_second";
  // 视频统一秒价即时折算：成本 ￥/秒 × 汇率 × 100 = 成本积分/秒；
  // 会员价留空时按当前倍率（无历史时 1.5x）由成本折算；两项都空 = 未定价。
  const videoFx = fxOf(priceForm.currency);
  const videoCostCredits = Math.max(0, Number(priceForm.costInput) || 0) * videoFx * 100;
  const videoMultiplierBps = cur?.multiplierBps ?? 15000;
  const videoMemberPreview =
    priceForm.memberInput.trim() !== ""
      ? Math.max(0, Number(priceForm.memberInput) || 0)
      : videoCostCredits > 0
        ? Math.ceil(videoCostCredits * (videoMultiplierBps / 10000))
        : null;
  const videoUnpriced = videoCostCredits <= 0 && videoMemberPreview == null;

  // 调价历史分页
  const priceRows = detail?.pricings || [];
  const pricePages = Math.max(1, Math.ceil(priceRows.length / PRICE_PAGE_SIZE));
  const pricePageRows = priceRows.slice((pricePage - 1) * PRICE_PAGE_SIZE, pricePage * PRICE_PAGE_SIZE);

  // 「获取所有模型」弹层：按可用性筛选后的行 + 当前筛选下可勾选的行（仅可用且未入库）
  const fetchRows = (fetchPreview?.items || []).filter((i) =>
    fetchFilter === "all"
      ? true
      : fetchFilter === "inDb"
        ? i.inDb
        : fetchFilter === "recover"
          ? i.available && i.inDb && i.dbStatus === "offline"
          : fetchFilter === "unavailable"
            ? !i.available
            : i.available && !i.inDb
  );
  const fetchPickableRows = fetchRows.filter((i) => i.available && !i.inDb);

  // 上游可用性中文说明
  const fetchReasonText = (i: FetchItem) =>
    i.unavailableReason === "status_unavailable"
      ? `上游状态 ${i.status || "Unavailable"}`
      : i.unavailableReason === "retiring"
        ? `待下线 ${i.status || "Retiring"}`
        : i.unavailableReason === "shutdown"
        ? `已到停用日期 ${i.shutdownDate || ""}`.trim()
        : i.unavailableReason === "internal"
          ? "仅内部可用"
          : "";

  // 渠道批量运营条（仅 API Key 页：测活 / 打标 / 修复 / 删除全部禁用）
  const keysBatchBar = (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-zinc-500">已选 {sel.length} 项</span>
      <button type="button" className={btnCls} disabled={busy || sel.length === 0} onClick={() => runKeyBatch("test")}>
        批量测活
      </button>
      <button type="button" className={btnCls} disabled={busy || sel.length === 0} onClick={() => runKeyBatch("enable")}>
        批量启用
      </button>
      <button type="button" className={btnCls} disabled={busy || sel.length === 0} onClick={() => runKeyBatch("disable")}>
        批量禁用
      </button>
      <button type="button" className={btnCls} disabled={busy || sel.length === 0} onClick={() => promptKeyTag("add")}>
        批量打标
      </button>
      <button type="button" className={btnCls} disabled={busy || sel.length === 0} onClick={() => promptKeyTag("remove")}>
        移除标签
      </button>
      <button type="button" className={btnCls} disabled={busy} onClick={() => runKeyBatch("repair")}>
        一致性修复
      </button>
      <button type="button" className={dangerBtnCls} disabled={busy} onClick={() => runKeyBatch("delete-disabled")}>
        删除全部禁用
      </button>
    </div>
  );

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
            <button type="button" className={primaryBtnCls} onClick={() => setModelForm({ mode: "create", vendorId: vendors[0]?.id, endpointType: "chat", status: "online", initCostInput: 0, initCostOutput: 0, initCurrency: "CNY" })}>
              新建模型
            </button>
            <button
              type="button"
              className={btnCls}
              onClick={() => {
                setFxDraft(fxRates.map((f) => ({ currency: f.currency, rate: String(f.rate) })));
                setFxModal(true);
              }}
            >
              汇率管理
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
                  <th className={thCls}>成本/会员价（按计价单位）</th>
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
                        ? `成本 ${fmtCredits(m.pricePreview.costInput)}/${fmtCredits(m.pricePreview.costOutput)} · 会员 ${m.pricePreview.memberInput}/${m.pricePreview.memberOutput} ${pricingUnitSuffix(m.pricePreview.unit)}`
                        : "-"}
                    </td>
                    <td className={tdCls}>
                      <div className="flex gap-2">
                        <button type="button" className={btnCls} onClick={() => openQuick(m)}>快速定价</button>
                        <button type="button" className={btnCls} onClick={() => openDetail(m.id)}>价格调整</button>
                        <button type="button" className={btnCls} onClick={() => { setEndpointDraft(m.endpoints.map((e) => ({ ...e }))); setEndpointPick(""); setModelForm({ mode: "edit", ...m }); }}>模型设置</button>
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
          {keySecurity && !keySecurity.configured && (
            <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              未配置独立的 STORAGE_KEY_SECRET，当前回退用 JWT_SECRET 加解密。
              轮换 JWT_SECRET 会让全部厂商 Key 解密失败，请尽快在 .env 配置独立的 STORAGE_KEY_SECRET 并重新保存各 Key。
            </div>
          )}
          {keysBatchBar}
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
                  <th className={thCls}>权重</th>
                  <th className={thCls}>健康</th>
                  <th className={thCls}>状态</th>
                  <th className={thCls}>标签</th>
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
                      <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-400">已配置</span>
                    </td>
                    <td className={tdCls}>{k.weight ?? 1}</td>
                    <td className={tdCls}>{keyHealthBadge(k)}</td>
                    <td className={tdCls}><StatusBadge status={k.status} /></td>
                    <td className={tdCls}>
                      {k.tags && k.tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {k.tags.map((t) => (
                            <span key={t} className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-xs text-indigo-300">
                              {t}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className={tdCls}>
                      <div className="relative flex gap-2">
                        <button type="button" className={btnCls} disabled={busy} onClick={() => fetchModelsOfKey(k)}>获取所有模型</button>
                        <button
                          type="button"
                          className={btnCls}
                          disabled={busy || !(vendors.find((v) => v.id === k.vendorId)?.modelCount ?? 0)}
                          title={(vendors.find((v) => v.id === k.vendorId)?.modelCount ?? 0) > 0 ? "按已入库模型 ID 匹配原价" : "请先「获取所有模型」入库后再取价"}
                          onClick={() => fetchPricesOfKey(k)}
                        >
                          获取原价
                        </button>
                        <button type="button" className={btnCls} onClick={() => setKeyForm({ mode: "edit", ...k })}>编辑</button>
                        {/* P5 维护窗口：维护期间该 Key 不参与选路 */}
                        <button type="button" className={btnCls} disabled={busy} onClick={() => setMaintainMenu(maintainMenu === k.id ? null : k.id)}>维护</button>
                        {maintainMenu === k.id && (
                          <div className="absolute right-0 top-8 z-20 flex gap-1 whitespace-nowrap rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-xl">
                            {[10, 30, 60].map((m) => (
                              <button key={m} type="button" className={btnCls} disabled={busy} onClick={() => setMaintain(k.id, m)}>{m}分钟</button>
                            ))}
                            <button type="button" className={dangerBtnCls} disabled={busy} onClick={() => setMaintain(k.id, 0)}>解除</button>
                          </div>
                        )}
                        <button type="button" className={dangerBtnCls} onClick={() => removeRow(`Key「${k.name}」`, `/api/admin/models/keys/${k.id}`)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {keys.length === 0 && (
                  <tr><td className={`${tdCls} text-center text-zinc-500`} colSpan={10}>暂无 Key</td></tr>
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
                  <option value="bytedance">字节跳动（bytedance）</option>
                  {vendorForm.protocol === "openspeech" && (
                    <option value="openspeech">字节跳动（历史标识 openspeech）</option>
                  )}
                  {vendorForm.protocol && !["openai", "anthropic", "gemini", "bytedance", "openspeech"].includes(vendorForm.protocol) && (
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
            {keyForm.mode === "edit" && (
              <div>
                <label className={labelCls}>路由权重（1-100，越大流量越多）</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  className={inputCls}
                  value={keyForm.weight ?? 1}
                  onChange={(e) => setKeyForm({ ...keyForm, weight: Number(e.target.value) || 1 })}
                />
              </div>
            )}
            <div>
              <label className={labelCls}>备注</label>
              <input className={inputCls} value={keyForm.remark || ""} onChange={(e) => setKeyForm({ ...keyForm, remark: e.target.value })} />
            </div>
            {/* v0.96 聚合 AI：创建后自动获取的可选参数 */}
            {keyForm.mode === "create" && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                <div className="mb-2 text-xs font-medium text-zinc-400">创建后自动获取（可选，聚合 AI）</div>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-xs text-zinc-300">
                    <input type="checkbox" checked={keyAutoFetch} onChange={(e) => setKeyAutoFetch(e.target.checked)} />
                    自动拉取模型清单并入库（GET /models + /models?type=video）
                  </label>
                  <label className="flex items-center gap-2 text-xs text-zinc-300">
                    <input type="checkbox" checked={keyAutoPricing} onChange={(e) => setKeyAutoPricing(e.target.checked)} />
                    自动拉取全量价格写入成本价（GET /models/pricing，仅补尚无定价的模型，汇率按汇率表换算）
                  </label>
                </div>
              </div>
            )}
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
                      body.weight = keyForm.weight ?? 1;
                    }
                    if (keyForm.mode === "create") {
                      const d = await apiCall("/api/admin/models/keys", jsonInit("POST", body));
                      // 创建后自动获取（可选）：模型清单入库 + 价格写入成本价
                      const newKeyId = d.key?.id ?? d.id;
                      if (keyAutoFetch && newKeyId) {
                        try {
                          const f = await apiCall(
                            `/api/admin/models/keys/${newKeyId}/fetch-models`,
                            jsonInit("POST", {
                              createAll: true,
                              applyPricing: keyAutoPricing,
                            })
                          );
                          flash("ok", `Key 已保存：自动入库 ${f.created} 个模型${keyAutoPricing ? `、写入成本价 ${f.priced} 条` : ""}`);
                        } catch {
                          flash("ok", "Key 已保存（自动获取模型失败，可稍后用「获取所有模型」补拉）");
                        }
                      } else {
                        flash("ok", "Key 已保存");
                      }
                    } else {
                      await apiCall(`/api/admin/models/keys/${keyForm.id}`, jsonInit("PUT", body));
                      flash("ok", "Key 已保存");
                    }
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
              上游共 {fetchPreview.total} 个模型（/models + /models?type=video）：可用 {fetchPreview.counts.available} / 不可用{" "}
              {fetchPreview.items.filter((i) => !i.available).length} / 已在库 {fetchPreview.counts.inDb} / 可入库候选{" "}
              {fetchPreview.counts.candidates}
              {fetchPreview.counts.toDeactivate > 0 && <>，确认后将同步标记下线 {fetchPreview.counts.toDeactivate} 个已失效模型</>}。
              仅勾选的「可用」模型会入库（已有模型不会被覆盖，不可用模型不入库）。
            </p>
            {fetchPreview.diff && (
              <p className="rounded-lg border border-indigo-900/50 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-200">
                变更检测：新增 {fetchPreview.diff.counts.added} / 将下线 {fetchPreview.diff.counts.toOffline} / 可恢复{" "}
                {fetchPreview.diff.counts.toRestore} / 参数变化 {fetchPreview.diff.counts.paramChanged}
                {fetchPreview.diff.counts.toRestore > 0 && "；已默认勾选「可恢复」模型，确认后重新上线"}
              </p>
            )}
            <p className="text-xs text-zinc-500">
              本次仅入库模型（不含价格）。模型入库完成后，可在 Key 列表用「获取原价」按已入库模型 ID 匹配填入成本价。
            </p>
            {/* 可用性筛选：只有 Available 且未入库的模型可勾选入库；Unavailable / 已在库 仅供查看 */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {(
                [
                  ["available", `可用未入库 ${fetchPreview.items.filter((i) => i.available && !i.inDb).length}`],
                  ["unavailable", `不可用 ${fetchPreview.items.filter((i) => !i.available).length}`],
                  ["inDb", `已在库 ${fetchPreview.items.filter((i) => i.inDb).length}`],
                  ["recover", `可恢复 ${fetchPreview.items.filter((i) => i.available && i.inDb && i.dbStatus === "offline").length}`],
                  ["all", `全部 ${fetchPreview.items.length}`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFetchFilter(key)}
                  className={`rounded-lg border px-2.5 py-1 ${
                    fetchFilter === key
                      ? "border-indigo-500 bg-indigo-500/15 text-indigo-300"
                      : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {fetchRows.length > 0 ? (
              <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-zinc-800">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className={thCls}>
                        <input
                          type="checkbox"
                          checked={fetchPickableRows.length > 0 && fetchPickableRows.every((i) => fetchSel.includes(i.name))}
                          disabled={fetchPickableRows.length === 0}
                          onChange={() =>
                            setFetchSel((s) => {
                              const names = fetchPickableRows.map((i) => i.name);
                              return names.every((n) => s.includes(n))
                                ? s.filter((n) => !names.includes(n))
                                : [...new Set([...s, ...names])];
                            })
                          }
                        />
                      </th>
                      <th className={thCls}>模型名称</th>
                      <th className={thCls}>类型</th>
                      <th className={thCls}>端点</th>
                      <th className={thCls}>归属</th>
                      <th className={thCls}>状态</th>
                      <th className={thCls}>功能参数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fetchRows.map((i) => {
                      const pickable = i.available && !i.inDb;
                      const restorable = i.inDb && i.available && i.dbStatus === "offline";
                      const checked = pickable
                        ? fetchSel.includes(i.name)
                        : restorable
                          ? fetchRestoreSel.includes(i.name)
                          : false;
                      return (
                        <tr key={i.name} className="hover:bg-zinc-800/40">
                          <td className={tdCls}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!pickable && !restorable}
                              onChange={() => (pickable ? toggleFetchSel(i.name) : toggleRestoreSel(i.name))}
                            />
                          </td>
                          <td className={`${tdCls} max-w-[280px] truncate`}>{i.name}</td>
                          <td className={tdCls}>{i.endpointType}</td>
                          <td className={tdCls}>{i.path || "-"}</td>
                          <td className={tdCls}>{i.ownedBy || "-"}</td>
                          <td className={tdCls}>
                            {i.inDb ? (
                              <>
                                <span
                                  className="rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-400"
                                  title={`库内状态 ${i.dbStatus || "-"}`}
                                >
                                  已在库
                                </span>
                                {i.available && i.dbStatus === "offline" && (
                                  <span className="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300">
                                    可恢复
                                  </span>
                                )}
                                {fetchPreview.diff?.paramChanged.includes(i.name) && (
                                  <span className="ml-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-xs text-violet-300">
                                    参数有变化
                                  </span>
                                )}
                              </>
                            ) : i.available ? (
                              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-400">可用</span>
                            ) : (
                              <>
                                <span className="rounded bg-zinc-700/60 px-1.5 py-0.5 text-xs text-zinc-400">不可用</span>
                                <span className="ml-1 text-xs text-zinc-500">{fetchReasonText(i)}</span>
                              </>
                            )}
                          </td>
                          <td className={`${tdCls} max-w-[180px] truncate`} title={i.videoParams ? JSON.stringify(i.videoParams) : undefined}>
                            {i.videoParams ? `${JSON.stringify(i.videoParams).slice(0, 30)}…` : "-"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="rounded-lg border border-zinc-800 bg-zinc-800/40 px-4 py-6 text-center text-sm text-zinc-500">
                当前筛选下没有模型（切换到「全部」可查看上游完整清单）
              </p>
            )}
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-zinc-500">
                已选新增 {fetchSel.length} / 恢复 {fetchRestoreSel.length}
              </span>
              <div className="flex gap-2">
                <button type="button" className={btnCls} onClick={() => setFetchPreview(null)}>取消</button>
                <button
                  type="button"
                  className={primaryBtnCls}
                  disabled={busy || (fetchSel.length === 0 && fetchRestoreSel.length === 0)}
                  onClick={importSelectedModels}
                >
                  应用变更（新增 {fetchSel.length}{fetchRestoreSel.length > 0 ? ` / 恢复 ${fetchRestoreSel.length}` : ""}）
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* ─── 获取原价：/models/pricing 按已入库模型 ID 匹配预览 + 填入成本价 ─── */}
      {priceFetch && (
        <Modal title={`获取原价 · ${priceFetch.vendorName}（按已入库模型匹配）`} wide onClose={() => setPriceFetch(null)}>
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">
              上游 /models/pricing 共 {priceFetch.total} 条价格：匹配在库模型 {priceFetch.matched} 条（待填入 {priceFetch.fillable} 条 / 已有定价跳过 {priceFetch.matched - priceFetch.fillable} 条），
              未入库未匹配 {priceFetch.total - priceFetch.matched} 条。仅给「尚无定价」的模型补成本价，已有调价不会被覆盖。
            </p>
            {priceFetch.entries.length > 0 ? (
              <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-zinc-800">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className={thCls}>模型 ID</th>
                      <th className={thCls}>输入价</th>
                      <th className={thCls}>输出价</th>
                      <th className={thCls}>币种</th>
                      <th className={thCls}>计量</th>
                      <th className={thCls}>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {priceFetch.entries.map((e) => (
                      <tr key={e.model} className="hover:bg-zinc-800/40">
                        <td className={`${tdCls} max-w-[280px] truncate`}>{e.model}</td>
                        <td className={tdCls}>{e.input ?? "-"}</td>
                        <td className={tdCls}>{e.output ?? "-"}</td>
                        <td className={tdCls}>{e.currency}</td>
                        <td className={tdCls}>{unitLabel(e)}</td>
                        <td className={tdCls}>
                          {e.state === "fill" ? (
                            <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-400">待填入</span>
                          ) : e.state === "hasPricing" ? (
                            <span className="rounded bg-zinc-700/50 px-1.5 py-0.5 text-xs text-zinc-400">已有定价跳过</span>
                          ) : (
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-400">未入库</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="rounded-lg border border-zinc-800 bg-zinc-800/40 px-4 py-6 text-center text-sm text-zinc-500">
                上游没有返回价格数据
              </p>
            )}
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-zinc-500">
                汇率（USD→RMB）：<span className="text-zinc-100">{fxOf("USD")}</span>
                <span className="text-zinc-500">（在「汇率管理」统一修改）</span>
              </span>
              <div className="flex gap-2">
                <button type="button" className={btnCls} onClick={() => setPriceFetch(null)}>取消</button>
                <button
                  type="button"
                  className={primaryBtnCls}
                  disabled={busy || priceFetch.fillable === 0}
                  onClick={applyFetchedPrices}
                >
                  填入价格（{priceFetch.fillable}）
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* ─── 模型弹层 ─── */}
      {modelForm && (
        <Modal title={modelForm.mode === "create" ? "新建模型" : "模型设置"} onClose={() => setModelForm(null)}>
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
                <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <input className={inputCls} type="number" step="any" min="0" placeholder={`成本价 输入（${unitLabel(null, modelForm.endpointType)}）`} value={modelForm.initCostInput ?? 0} onChange={(e) => setModelForm({ ...modelForm, initCostInput: Number(e.target.value) })} />
                  <input className={inputCls} type="number" step="any" min="0" placeholder={`成本价 输出（${unitLabel(null, modelForm.endpointType)}）`} value={modelForm.initCostOutput ?? 0} onChange={(e) => setModelForm({ ...modelForm, initCostOutput: Number(e.target.value) })} />
                  <select className={inputCls} value={modelForm.initCurrency || "CNY"} onChange={(e) => setModelForm({ ...modelForm, initCurrency: e.target.value })}>
                    <option value="CNY">CNY 人民币</option>
                    {fxRates.filter((r) => r.currency !== "CNY").map((r) => (
                      <option key={r.currency} value={r.currency}>{r.currency}（1 {r.currency} = {r.rate} 元）</option>
                    ))}
                  </select>
                  <input className={inputCls} type="number" step="any" min="0" placeholder={`会员价 输入（积分/${unitLabel(null, modelForm.endpointType)}）`} value={modelForm.initMemberInput ?? ""} onChange={(e) => setModelForm({ ...modelForm, initMemberInput: e.target.value === "" ? undefined : Number(e.target.value) })} />
                  <input className={inputCls} type="number" step="any" min="0" placeholder={`会员价 输出（积分/${unitLabel(null, modelForm.endpointType)}）`} value={modelForm.initMemberOutput ?? ""} onChange={(e) => setModelForm({ ...modelForm, initMemberOutput: e.target.value === "" ? undefined : Number(e.target.value) })} />
                </div>
                <p className="text-xs text-zinc-500">
                  成本积分（自动计算，1 元 = 100 积分）：
                  输入 {fmtCredits((modelForm.initCostInput ?? 0) * fxOf(modelForm.initCurrency || "CNY") * 100)} ·
                  输出 {fmtCredits((modelForm.initCostOutput ?? 0) * fxOf(modelForm.initCurrency || "CNY") * 100)}
                  （外币按「汇率管理」的汇率换算 RMB，导入后可微调）
                </p>
              </div>
            )}
            <div>
              <label className={labelCls}>备注</label>
              <input className={inputCls} value={modelForm.remark || ""} onChange={(e) => setModelForm({ ...modelForm, remark: e.target.value })} />
            </div>
            {modelForm.mode === "edit" && (
              <>
                <div>
                  <label className={labelCls}>端点管理</label>
                  <div className="mb-2 space-y-2">
                    {endpointDraft.map((e, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          className={`${inputCls} min-w-0 flex-1`}
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
                          className={`${dangerBtnCls} shrink-0 whitespace-nowrap`}
                          onClick={() => setEndpointDraft(endpointDraft.filter((_, j) => j !== i))}
                        >
                          移除
                        </button>
                      </div>
                    ))}
                    {endpointDraft.length === 0 && <p className="text-xs text-zinc-500">暂无端点，从下方下拉框添加。</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <select className={`${selectCls} min-w-0 flex-1`} value={endpointPick} onChange={(e) => setEndpointPick(e.target.value)}>
                      <option value="">选择端点接口添加…</option>
                      {[
                        ...ENDPOINT_OPTIONS,
                        ...endpointDraft
                          .map((e) => e.path.trim())
                          .filter((p) => p && !ENDPOINT_OPTIONS.some((o) => o.value === p))
                          .map((p) => ({ value: p, label: p })),
                      ].map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={`${btnCls} shrink-0 whitespace-nowrap`}
                      disabled={!endpointPick || endpointDraft.some((e) => e.path.trim() === endpointPick)}
                      onClick={() => {
                        setEndpointDraft([...endpointDraft, { path: endpointPick, enabled: true }]);
                        setEndpointPick("");
                      }}
                    >
                      添加端点
                    </button>
                  </div>
                </div>
                <div>
                  <label className={labelCls}>高级配置（JSON：该模型参数与细节调整）</label>
                  <textarea
                    className={`${inputCls} font-mono`}
                    rows={6}
                    placeholder={'{\n  "temperature": 0.7,\n  "max_tokens": 4096,\n  "top_p": 1\n}'}
                    value={modelForm.advancedConfig || ""}
                    onChange={(e) => setModelForm({ ...modelForm, advancedConfig: e.target.value })}
                  />
                  <p className="mt-1 text-xs text-zinc-500">留空 = 不覆盖默认参数；保存时校验 JSON 合法性。</p>
                </div>
              </>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className={btnCls} onClick={() => setModelForm(null)}>取消</button>
              <button
                type="button"
                className={primaryBtnCls}
                disabled={busy || !modelForm.vendorId || !modelForm.name || !modelForm.displayName}
                onClick={() =>
                  submit(async () => {
                    if (modelForm.mode === "create") {
                      // v0.96 直观定价：成本价（供应商币种）→ 成本积分自动换算；会员价直接填积分
                      const costIn = modelForm.initCostInput ?? 0;
                      const costOut = modelForm.initCostOutput ?? 0;
                      const currency = (modelForm.initCurrency || "CNY").toUpperCase();
                      const fx = fxOf(currency);
                      const memberIn = modelForm.initMemberInput;
                      const memberOut = modelForm.initMemberOutput;
                      const hasPrice = costIn > 0 || costOut > 0 || memberIn != null || memberOut != null;
                      const costCreditsSum = (costIn + costOut) * fx * 100;
                      const memberSum = (memberIn ?? 0) + (memberOut ?? 0);
                      const multiplierBps =
                        costCreditsSum > 0 && memberSum > 0
                          ? Math.max(1, Math.min(100_000, Math.round((memberSum / costCreditsSum) * 10_000)))
                          : 15000;
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
                                  inputPrice: costIn,
                                  outputPrice: costOut,
                                  currency,
                                  fxRateE8: Math.round(fx * 1e8),
                                  multiplierBps,
                                  memberInputPrice: memberIn ?? null,
                                  memberOutputPrice: memberOut ?? null,
                                },
                              }
                            : {}),
                        })
                      );
                    } else {
                      // 模型设置：基础信息 + 高级配置（JSON 校验）+ 端点管理
                      const adv = (modelForm.advancedConfig || "").trim();
                      if (adv) {
                        try {
                          JSON.parse(adv);
                        } catch {
                          throw new Error("高级配置不是合法 JSON");
                        }
                      }
                      await apiCall(
                        `/api/admin/models/models/${modelForm.id}`,
                        jsonInit("PUT", {
                          displayName: modelForm.displayName?.trim(),
                          endpointType: modelForm.endpointType,
                          status: modelForm.status,
                          remark: modelForm.remark || undefined,
                          advancedConfig: adv || null,
                        })
                      );
                      await saveEndpointsFor(modelForm.id!, endpointDraft);
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

      {/* ─── 价格调整：成本价格 / 出售价格 / 调价历史 ─── */}
      {detail && (
        <Modal title={`价格调整：${detail.model.displayName}（${detail.model.name}）`} onClose={() => setDetail(null)} wide>
          <div className="space-y-5">
            {/* 成本价格 与 出售价格 */}
            <div className={cardCls}>
              <h4 className="mb-2 text-sm font-medium text-zinc-300">成本价格 与 出售价格</h4>
              {detail.currentPricing ? (
                (() => {
                  const p0 = detail.currentPricing;
                  return (
                    <p className="mb-3 text-xs text-zinc-500">
                      当前生效：成本 {p0.inputPrice} / {p0.outputPrice}（{p0.currency} / {unitLabel(p0)}）
                      　成本积分 {fmtCredits(costCreditsPerUnit(p0, "input"))} / {fmtCredits(costCreditsPerUnit(p0, "output"))}
                      　出售 {fmtCredits(memberCreditsPerUnit(p0, "input"))} / {fmtCredits(memberCreditsPerUnit(p0, "output"))}（积分 / {unitLabel(p0)}）
                      　生效于 {new Date(p0.effectiveAt).toLocaleString("zh-CN")}
                    </p>
                  );
                })()
              ) : (
                <p className="mb-3 text-sm text-amber-400">
                  {detail.model.endpointType === "video"
                    ? "尚未设置统一秒价：请填写统一秒价，或至少给某个分辨率档位填价（全空 = 未定价）。"
                    : "尚未定价，网关按最低 1 分兜底。"}
                </p>
              )}
              {/* 成本价区（蓝）：真实货币价 + 币种/汇率 + 成本积分 */}
              <div className="mb-3 rounded-lg border border-sky-800/50 bg-sky-950/25 p-3">
                <div className="mb-3 flex items-center gap-2">
                  <h5 className="whitespace-nowrap text-sm font-semibold text-sky-300">成本价</h5>
                  <span className="h-px flex-1 bg-sky-800/60" />
                </div>
                {/* v0.113 计价单位：按张 / 按视频秒 / 按次 / 按 tokens（决定 meterBase 与计费口径） */}
                <div className="mb-2">
                  <label className={labelCls}>计价单位</label>
                  <select
                    className={inputCls}
                    value={priceForm.unit}
                    onChange={(e) => setPriceForm({ ...priceForm, unit: e.target.value })}
                  >
                    <option value="token-1m">按 1M tokens（积分/百万 tokens）</option>
                    <option value="token-1k">按 1K tokens（积分/千 tokens）</option>
                    <option value="image">按张（积分/张）</option>
                    <option value="video_second">按视频秒（积分/秒）</option>
                    <option value="audio_second">按音频秒（积分/秒）</option>
                    <option value="char">按千字符（积分/千字符）</option>
                    <option value="request">按次（积分/次）</option>
                  </select>
                  {detail.model.endpointType === "video" && priceForm.unit === "video_second" && (
                    <p className="mt-1 text-xs text-zinc-500">
                      按视频秒计价：档位填了价就按档位走，档位留空回退统一秒价，两者全空即未定价。
                    </p>
                  )}
                  {detail.model.endpointType === "video" && priceForm.unit !== "video_second" && (
                    <p className="mt-1 text-xs text-amber-400">
                      视频模型改为「{unitShort}」后按普通计量计费，分辨率档位不参与；一般保持「按视频秒」。
                    </p>
                  )}
                </div>
                <div className="mb-2 grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelCls}>币种</label>
                    <select className={inputCls} value={priceForm.currency} onChange={(e) => setPriceForm({ ...priceForm, currency: e.target.value })}>
                      <option value="CNY">CNY 人民币</option>
                      {fxRates.filter((r) => r.currency !== "CNY").map((r) => (
                        <option key={r.currency} value={r.currency}>{r.currency}（1 {r.currency} = {r.rate} 元）</option>
                      ))}
                    </select>
                  </div>
                  {priceForm.currency.toUpperCase() !== "CNY" && (
                    <div>
                      <label className={labelCls}>汇率 {priceForm.currency}→RMB（只读）</label>
                      <div className="rounded-lg border border-zinc-800 bg-zinc-800/50 px-3 py-2 text-sm text-zinc-400">
                        {fxOf(priceForm.currency)}
                        <span className="ml-1 text-xs text-zinc-500">（「汇率管理」统一修改）</span>
                      </div>
                    </div>
                  )}
                </div>
                {isVideoUnit ? (
                  <>
                    {/* 视频统一秒价：通用行的成本价；会员价在下「出售价格」区，档位价在「分辨率档位价」区 */}
                    <p className="mb-2 text-xs text-zinc-500">
                      统一秒价：档位留空时按此价计费，档位单独填价则优先按档位走。两项全空 = 未定价。
                    </p>
                    <div className="mb-2">
                      <label className={labelCls}>统一秒价 成本 ￥/秒（真实货币，可留空）</label>
                      <input
                        className={inputCls}
                        type="number"
                        step="any"
                        min="0"
                        placeholder="留空 = 未定价"
                        value={priceForm.costInput}
                        onChange={(e) => setPriceForm({ ...priceForm, costInput: e.target.value })}
                      />
                      <span className="mt-1 block text-xs text-zinc-500">
                        {priceForm.costInput.trim() === ""
                          ? "成本未填"
                          : `≈ ${fmtCredits(videoCostCredits)} 积分/秒`}
                      </span>
                    </div>
                    <p className={`text-sm font-semibold ${videoUnpriced ? "text-amber-400" : "text-red-400"}`}>
                      {videoUnpriced
                        ? "统一秒价未定价：若档位也未填价，视频生成会被拒绝，前台也不展示价格。"
                        : `即时折算：成本 ${videoCostCredits > 0 ? fmtCredits(videoCostCredits) : "—"} · 会员 ${videoMemberPreview != null ? fmtCredits(videoMemberPreview) : "—"} 积分/秒`}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="mb-2 grid grid-cols-2 gap-2">
                      <div>
                        <label className={labelCls}>输入{unitShort} ￥（真实货币价）</label>
                        <input className={inputCls} type="number" step="any" min="0" placeholder="填数字" value={priceForm.costInput} onChange={(e) => setPriceForm({ ...priceForm, costInput: e.target.value })} />
                      </div>
                      <div>
                        <label className={labelCls}>输出{unitShort} ￥（真实货币价）</label>
                        <input className={inputCls} type="number" step="any" min="0" placeholder="填数字" value={priceForm.costOutput} onChange={(e) => setPriceForm({ ...priceForm, costOutput: e.target.value })} />
                      </div>
                    </div>
                    <p className="text-base font-semibold text-red-400">
                      成本积分：输入 {fmtCredits(pfCostIn)} · 输出 {fmtCredits(pfCostOut)} 积分（1 元 = 100 积分）
                    </p>
                  </>
                )}
              </div>
              {/* 出售价格区（绿）：视频秒展示统一秒价会员价；其他单位输入/输出两栏 */}
              <div className="mb-3 rounded-lg border border-emerald-800/50 bg-emerald-950/25 p-3">
                <div className="mb-3 flex items-center gap-2">
                  <h5 className="whitespace-nowrap text-sm font-semibold text-emerald-300">出售价格</h5>
                  <span className="h-px flex-1 bg-emerald-800/60" />
                </div>
                {isVideoUnit ? (
                  <>
                    <div className="mb-2">
                      <label className={labelCls}>统一秒价 会员价（积分/秒，可留空）</label>
                      <input
                        className={inputCls}
                        type="number"
                        step="any"
                        min="0"
                        placeholder="留空 = 按成本×倍率折算"
                        value={priceForm.memberInput}
                        onChange={(e) => setPriceForm({ ...priceForm, memberInput: e.target.value })}
                      />
                    </div>
                    <p className="text-xs text-zinc-500">
                      档位填了价则按档位走，此价作为档位留空时的回退价；与成本价都留空 = 未定价。
                      {priceForm.memberInput.trim() !== ""
                        ? `　会员 ${fmtCredits(Math.max(0, Number(priceForm.memberInput) || 0))} 积分/秒`
                        : videoMemberPreview != null
                          ? `　≈ ${fmtCredits(videoMemberPreview)} 积分/秒（成本×${(videoMultiplierBps / 10000).toFixed(2)}）`
                          : ""}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className={labelCls}>输入{unitShort}（积分）</label>
                        <input className={inputCls} type="number" step="any" min="0" placeholder="留空 = 按兜底系数" value={priceForm.memberInput} onChange={(e) => setPriceForm({ ...priceForm, memberInput: e.target.value })} />
                      </div>
                      <div>
                        <label className={labelCls}>输出{unitShort}（积分）</label>
                        <input className={inputCls} type="number" step="any" min="0" placeholder="留空 = 按兜底系数" value={priceForm.memberOutput} onChange={(e) => setPriceForm({ ...priceForm, memberOutput: e.target.value })} />
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-zinc-500">
                      即时折算：会员 输入{" "}
                      {fmtCredits(
                        priceForm.memberInput.trim() !== ""
                          ? Math.max(0, Number(priceForm.memberInput) || 0)
                          : pfCostIn * 1.5
                      )}{" "}
                      · 输出{" "}
                      {fmtCredits(
                        priceForm.memberOutput.trim() !== ""
                          ? Math.max(0, Number(priceForm.memberOutput) || 0)
                          : pfCostOut * 1.5
                      )}{" "}
                      积分 / {unitLabel(cur, detail.model.endpointType)}（留空按成本×1.5x 折算）
                    </p>
                  </>
                )}
              </div>
              {/* 分辨率档位价（仅视频秒）：档位填价优先，留空回退统一秒价 */}
              {isVideoUnit && (
                <div className="mb-3 rounded-lg border border-indigo-800/50 bg-indigo-950/20 p-3">
                  <div className="mb-3 flex items-center gap-2">
                    <h5 className="whitespace-nowrap text-sm font-semibold text-indigo-300">分辨率档位价（可选）</h5>
                    <span className="h-px flex-1 bg-indigo-800/60" />
                  </div>
                  <div className="mb-3 flex gap-2">
                    {(["n", "v"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setPriceForm({ ...priceForm, tierTab: t })}
                        className={`rounded-lg border px-3 py-1.5 text-xs ${
                          priceForm.tierTab === t
                            ? "border-indigo-500 bg-indigo-600/30 text-indigo-100"
                            : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                        }`}
                      >
                        {t === "n" ? "无视频输入" : "含参考视频"}
                      </button>
                    ))}
                  </div>
                  <div className="space-y-2">
                    {VIDEO_RESOLUTIONS.map((res) => {
                      const key = `${res}:${priceForm.tierTab}`;
                      const tier = priceForm.tiers[key] ?? { cost: "", member: "" };
                      const costCredits = (Number(tier.cost) || 0) * videoFx * 100;
                      const memberCredits =
                        tier.member.trim() !== ""
                          ? Math.max(0, Number(tier.member) || 0)
                          : costCredits > 0
                            ? Math.ceil(costCredits * (videoMultiplierBps / 10000))
                            : null;
                      return (
                        <div key={key} className="grid grid-cols-[64px_1fr_1fr] items-center gap-2">
                          <span className="text-xs text-zinc-400">{res}</span>
                          <div>
                            <input
                              className={inputCls}
                              type="number"
                              step="any"
                              min="0"
                              placeholder="成本 ￥/秒（留空=回退统一秒价）"
                              value={tier.cost}
                              onChange={(e) =>
                                setPriceForm((f) => ({
                                  ...f,
                                  tiers: {
                                    ...f.tiers,
                                    [key]: { ...(f.tiers[key] ?? { cost: "", member: "" }), cost: e.target.value },
                                  },
                                }))
                              }
                            />
                            <span className="mt-0.5 block text-xs text-zinc-500">
                              {tier.cost.trim() === "" ? "—" : `≈ ${fmtCredits(costCredits)} 积分/秒`}
                            </span>
                          </div>
                          <div>
                            <input
                              className={inputCls}
                              type="number"
                              step="any"
                              min="0"
                              placeholder="会员 积分/秒（留空=按成本折算）"
                              value={tier.member}
                              onChange={(e) =>
                                setPriceForm((f) => ({
                                  ...f,
                                  tiers: {
                                    ...f.tiers,
                                    [key]: { ...(f.tiers[key] ?? { cost: "", member: "" }), member: e.target.value },
                                  },
                                }))
                              }
                            />
                            <span className="mt-0.5 block text-xs text-zinc-500">
                              {memberCredits != null ? `会员 ${fmtCredits(memberCredits)} 积分/秒` : "未定价"}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-xs text-zinc-500">
                    档位填了价就按档位计费；档位留空回退上面的统一秒价；两边全空 = 该档位未定价（会拒绝下单）。
                  </p>
                </div>
              )}
              <div className="mb-2 grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>生效时间（默认当前时间）</label>
                  <input className={inputCls} type="datetime-local" value={priceForm.effectiveAt} onChange={(e) => setPriceForm({ ...priceForm, effectiveAt: e.target.value })} />
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    className={btnCls}
                    onClick={() => {
                      const now = new Date();
                      const pad = (n: number) => String(n).padStart(2, "0");
                      setPriceForm({ ...priceForm, effectiveAt: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}` });
                    }}
                  >
                    现在
                  </button>
                </div>
              </div>
              <div className="mb-2 flex items-center gap-3">
                {!isVideoUnit && (
                  <button type="button" className={btnCls} onClick={runProfit}>
                    成本试算
                  </button>
                )}
                <button
                  type="button"
                  className={primaryBtnCls}
                  disabled={busy || savingPrice}
                  onClick={savePricing}
                >
                  {savingPrice ? "提交中…" : "确认调价"}
                </button>
                <span className="text-xs text-zinc-500">默认当前时间即立即生效；旧记录保留可追溯</span>
              </div>
              {profit && !isVideoUnit && (
                <p className="text-base font-semibold text-emerald-400">
                  成本试算：每 {unitLabel(cur, detail.model.endpointType)} 利润积分 = 出售 − 成本
                  　输入 {fmtCredits(profit.in)} · 输出 {fmtCredits(profit.out)}
                </p>
              )}
            </div>

            {/* 调价历史 */}
            <div className={cardCls}>
              <h4 className="mb-2 text-sm font-medium text-zinc-300">调价历史（只增不改，按生效时间取最新）</h4>
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={thCls}>生效时间</th>
                    <th className={thCls}>成本价 输入/输出</th>
                    <th className={thCls}>成本积分 输入/输出</th>
                    <th className={thCls}>会员价（积分）输入/输出</th>
                    <th className={thCls}>币种/计量</th>
                  </tr>
                </thead>
                <tbody>
                  {pricePageRows.map((p) => (
                    <tr key={p.id}>
                      <td className={tdCls}>{new Date(p.effectiveAt).toLocaleString("zh-CN")}</td>
                      <td className={tdCls}>{p.inputPrice} / {p.outputPrice}</td>
                      <td className={tdCls}>{fmtCredits(costCreditsPerUnit(p, "input"))} / {fmtCredits(costCreditsPerUnit(p, "output"))}</td>
                      <td className={tdCls}>
                        {p.memberInputPrice != null ? fmtCredits(p.memberInputPrice) : "-"} / {p.memberOutputPrice != null ? fmtCredits(p.memberOutputPrice) : "-"}
                      </td>
                      <td className={tdCls}>{p.currency} · 每 {p.meterBase} {p.unit}</td>
                    </tr>
                  ))}
                  {priceRows.length === 0 && (
                    <tr><td className={`${tdCls} text-center text-zinc-500`} colSpan={5}>暂无定价记录</td></tr>
                  )}
                </tbody>
              </table>
              {pricePages > 1 && (
                <div className="mt-3 flex items-center justify-end gap-2">
                  <button type="button" className={btnCls} disabled={pricePage <= 1} onClick={() => setPricePage(pricePage - 1)}>
                    上一页
                  </button>
                  <span className="text-xs text-zinc-500">第 {pricePage} / {pricePages} 页 · 共 {priceRows.length} 条</span>
                  <button type="button" className={btnCls} disabled={pricePage >= pricePages} onClick={() => setPricePage(pricePage + 1)}>
                    下一页
                  </button>
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* ─── 汇率管理：币种 → RMB 基本常量，模型管理内所有汇率统一引用 ─── */}
      {fxModal && (
        <Modal title="汇率管理（币种 → RMB）" onClose={() => setFxModal(false)}>
          <p className="mb-3 text-xs text-zinc-500">
            汇率是模型管理的基本常量：所有定价的汇率统一引用这里（CNY 固定 1 不用配置），定价处不可编辑。
            保存后自动同步该币种已有定价的汇率快照。
          </p>
          <div className="mb-3 space-y-2">
            {fxDraft.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  className={`${inputCls} flex-[0_0_7rem] uppercase`}
                  placeholder="USD"
                  maxLength={3}
                  value={r.currency}
                  onChange={(e) => {
                    const next = [...fxDraft];
                    next[i] = { ...next[i], currency: e.target.value.toUpperCase() };
                    setFxDraft(next);
                  }}
                />
                <input
                  className={`${inputCls} min-w-0 flex-1`}
                  type="number"
                  step="any"
                  min="0"
                  placeholder="汇率（1 外币 = ? 元）"
                  value={r.rate}
                  onChange={(e) => {
                    const next = [...fxDraft];
                    next[i] = { ...next[i], rate: e.target.value };
                    setFxDraft(next);
                  }}
                />
                <button type="button" className={`${dangerBtnCls} shrink-0 whitespace-nowrap`} onClick={() => setFxDraft(fxDraft.filter((_, j) => j !== i))}>
                  移除
                </button>
              </div>
            ))}
            {fxDraft.length === 0 && <p className="text-sm text-zinc-500">暂无外币汇率，点「添加币种」新建。</p>}
          </div>
          <div className="flex items-center justify-between">
            <button type="button" className={btnCls} onClick={() => setFxDraft([...fxDraft, { currency: "", rate: "" }])}>
              添加币种
            </button>
            <div className="flex gap-2">
              <button type="button" className={btnCls} onClick={() => setFxModal(false)}>取消</button>
              <button
                type="button"
                className={primaryBtnCls}
                disabled={busy}
                onClick={() =>
                  submit(async () => {
                    for (const r of fxDraft) {
                      if (!r.currency.trim() && !r.rate.trim()) continue;
                      if (!/^[A-Za-z]{3}$/.test(r.currency) || r.currency === "CNY") {
                        throw new Error("币种需为 3 位字母（CNY 固定 1 无需配置）");
                      }
                      if (!(Number(r.rate) > 0)) throw new Error(`币种 ${r.currency} 的汇率需大于 0`);
                    }
                    const rates = fxDraft
                      .filter((r) => r.currency.trim())
                      .map((r) => ({ currency: r.currency.toUpperCase(), rate: Number(r.rate) }));
                    await apiCall("/api/admin/models/fx", jsonInit("PUT", { rates }));
                    flash("ok", "汇率已保存并同步定价快照");
                    setFxModal(false);
                    await loadFx();
                    refreshCurrent();
                  })
                }
              >
                保存汇率
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ─── b19 单模型快速定价抽屉：倍率 / 按次 / 当前缓存价收敛一表单，输入即折算 ─── */}
      {quick && (
        <div className="fixed inset-0 z-[70] flex justify-end">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => {
              if (!quickSaving) setQuick(null);
            }}
          />
          <aside className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-zinc-100">快速定价</h3>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {quick.model.displayName} · {quick.model.name} · {quick.model.endpointType}
                </p>
              </div>
              <button type="button" className={btnCls} disabled={quickSaving} onClick={() => setQuick(null)}>
                关闭
              </button>
            </div>

            {/* 当前缓存价：模型列表服务端快照，只读参考 */}
            <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
              <div className="mb-1 text-xs text-zinc-500">当前缓存价（列表快照，只读）</div>
              {quick.model.currentPricing ? (
                <>
                  <div className="text-sm text-zinc-200">
                    成本 {quick.model.currentPricing.inputPrice} / {quick.model.currentPricing.outputPrice}{" "}
                    {quick.model.currentPricing.currency} · 倍率{" "}
                    {(quick.model.currentPricing.multiplierBps / 10000).toFixed(2)}x
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    会员 {fmtCredits(qCurMemberIn)} / {fmtCredits(qCurMemberOut)} 积分 /{" "}
                    {unitLabel(quick.model.currentPricing)}
                  </div>
                </>
              ) : (
                <div className="text-sm text-amber-400">
                  {quick.model.endpointType === "video"
                    ? "尚未定价（视频生成会拒绝下单，请在「价格调整」填统一秒价或档位价）"
                    : "尚未定价（网关按最低 1 分兜底）"}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>计价单位</label>
                  <select
                    className={inputCls}
                    value={quick.unit}
                    onChange={(e) => setQuick({ ...quick, unit: e.target.value })}
                  >
                    <option value="token-1m">按 1M tokens</option>
                    <option value="token-1k">按 1K tokens</option>
                    <option value="image">按张</option>
                    <option value="request">按次</option>
                    <option value="audio_second">按音频秒</option>
                    <option value="char">按千字符</option>
                    <option value="video_second">按视频秒（请用「价格调整」）</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>币种</label>
                  <select
                    className={inputCls}
                    value={quick.currency}
                    onChange={(e) => setQuick({ ...quick, currency: e.target.value })}
                  >
                    <option value="CNY">CNY 人民币</option>
                    {fxRates
                      .filter((r) => r.currency !== "CNY")
                      .map((r) => (
                        <option key={r.currency} value={r.currency}>
                          {r.currency}（1 {r.currency} = {r.rate} 元）
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>输入{quickUnitShort} ￥（成本价）</label>
                  <input
                    className={inputCls}
                    type="number"
                    step="any"
                    min="0"
                    value={quick.costInput}
                    onChange={(e) => setQuick({ ...quick, costInput: e.target.value })}
                  />
                </div>
                <div>
                  <label className={labelCls}>输出{quickUnitShort} ￥（成本价）</label>
                  <input
                    className={inputCls}
                    type="number"
                    step="any"
                    min="0"
                    value={quick.costOutput}
                    onChange={(e) => setQuick({ ...quick, costOutput: e.target.value })}
                  />
                </div>
              </div>

              <div>
                <label className={labelCls}>定价方式</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={
                      quick.mode === "multiplier"
                        ? "rounded-lg border border-indigo-500 bg-indigo-600/30 px-3 py-1.5 text-sm text-indigo-200"
                        : btnCls
                    }
                    onClick={() => setQuick({ ...quick, mode: "multiplier" })}
                  >
                    按倍率
                  </button>
                  <button
                    type="button"
                    className={
                      quick.mode === "member"
                        ? "rounded-lg border border-indigo-500 bg-indigo-600/30 px-3 py-1.5 text-sm text-indigo-200"
                        : btnCls
                    }
                    onClick={() =>
                      setQuick({
                        ...quick,
                        mode: "member",
                        memberInput: quick.memberInput || String(qMemberIn),
                        memberOutput: quick.memberOutput || String(qMemberOut),
                      })
                    }
                  >
                    按会员价
                  </button>
                </div>
              </div>

              {quick.mode === "multiplier" ? (
                <div>
                  <label className={labelCls}>倍率（成本积分 → 会员积分）</label>
                  <input
                    className={inputCls}
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={quick.multiplier}
                    onChange={(e) => setQuick({ ...quick, multiplier: e.target.value })}
                  />
                  <p className="mt-1 text-xs text-zinc-500">
                    折算会员价：输入 {fmtCredits(qMemberIn)} / 输出 {fmtCredits(qMemberOut)} 积分 /{" "}
                    {quickUnitShort}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelCls}>输入{quickUnitShort}（会员积分）</label>
                    <input
                      className={inputCls}
                      type="number"
                      step="any"
                      min="0"
                      value={quick.memberInput}
                      onChange={(e) => setQuick({ ...quick, memberInput: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>输出{quickUnitShort}（会员积分）</label>
                    <input
                      className={inputCls}
                      type="number"
                      step="any"
                      min="0"
                      value={quick.memberOutput}
                      onChange={(e) => setQuick({ ...quick, memberOutput: e.target.value })}
                    />
                  </div>
                  <p className="col-span-2 text-xs text-zinc-500">
                    折算倍率：{qMultiplier.toFixed(2)}x · 成本积分 {fmtCredits(qCostIn)} /{" "}
                    {fmtCredits(qCostOut)}
                  </p>
                </div>
              )}

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-500">成本积分 / {quickUnitShort}</span>
                  <span className="text-red-400">
                    {fmtCredits(qCostIn)} / {fmtCredits(qCostOut)}
                  </span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-zinc-500">会员积分 / {quickUnitShort}</span>
                  <span className="text-emerald-400">
                    {fmtCredits(qMemberIn)} / {fmtCredits(qMemberOut)}
                  </span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-zinc-500">折算倍率</span>
                  <span className="text-zinc-200">{qMultiplier.toFixed(2)}x</span>
                </div>
              </div>

              <div className="grid grid-cols-2 items-end gap-2">
                <div>
                  <label className={labelCls}>生效时间（默认当前）</label>
                  <input
                    className={inputCls}
                    type="datetime-local"
                    value={quick.effectiveAt}
                    onChange={(e) => setQuick({ ...quick, effectiveAt: e.target.value })}
                  />
                </div>
                <div>
                  <button
                    type="button"
                    className={btnCls}
                    onClick={() => {
                      const now = new Date();
                      const pad = (n: number) => String(n).padStart(2, "0");
                      setQuick({
                        ...quick,
                        effectiveAt: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`,
                      });
                    }}
                  >
                    现在
                  </button>
                </div>
              </div>

              {quick.unit === "video_second" ? (
                <p className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-xs text-amber-300">
                  视频秒要按 480p/720p/1080p/4K 档位分别定价，请关闭抽屉后点「价格调整」填写矩阵。
                </p>
              ) : (
                <button
                  type="button"
                  className={primaryBtnCls}
                  disabled={quickSaving}
                  onClick={saveQuick}
                >
                  {quickSaving ? "提交中…" : "确认调价"}
                </button>
              )}
              <p className="text-xs text-zinc-600">
                只新增价格版本，历史保留可追溯。缓存命中价当前计费口径未启用（需先拍板），本抽屉不写入该字段。
              </p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
