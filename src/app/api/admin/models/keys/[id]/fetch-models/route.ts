import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";
import { computeModelDiff } from "@/lib/admin/model-sync";

export const dynamic = "force-dynamic";

// ─── 获取所有模型：预览上游可用模型清单 + 勾选入库 ───
// GET  /api/admin/models/keys/[id]/fetch-models
//   预览（只读）：上游 OpenAI 兼容 GET /models（默认 chat+image）+ GET /models?type=video（视频模型含功能参数），
//   返回「可用且未入库」的候选模型清单（含启发式 endpointType / 端点 path / 视频功能参数）与汇总计数；
//   ?withPricing=1 时同时拉 GET /models/pricing（全量模型价格），返回价格条目供写入成本价。
// POST /api/admin/models/keys/[id]/fetch-models
//   body: { names: string[], applyPricing?: boolean, fxRate?: number, createAll?: boolean }
//   勾选入库：仅创建勾选的候选模型（@@unique([vendorId,name]) 幂等），同时同步已在库模型的可用性；
//   applyPricing=true 时把 /models/pricing 价格写入「尚无定价」模型的成本价（USD 按 fxRate 汇率换算 RMB 计费）。

// 端点类型启发式判定：视频家族先匹配（v0.113 修复 image-to-video 等被 "image" 误判为图片模型），默认 chat
function guessEndpointType(name: string): "chat" | "image" | "video" | "audio" {
  const n = name.toLowerCase();
  if (/-to-video|video-to-video|i2v|t2v|r2v|sora|video|veo|kling|runway|pika|hailuo|wan|keling|seedance|minimax-h3/.test(n)) return "video";
  if (/dall-e|image|flux|seedream|stable-diffusion|midjourney|\bsd[-_ ]?\d/.test(n)) return "image";
  if (/whisper|tts|speech|audio/.test(n)) return "audio";
  return "chat";
}

// 上游模型条目：id + 停用日期 + 归属 + 可用状态 + 视频功能参数（/models?type=video 额外字段）
interface UpstreamModel {
  id: string;
  shutdownDate: string | null;
  ownedBy: string | null;
  status: string | null;
  params: Record<string, unknown> | null;
}

// 提取模型对象里的 shutdown_date（兼容 shutdownDate 驼峰写法）
function parseShutdownDate(m: Record<string, unknown>): string | null {
  const raw = m.shutdown_date ?? m.shutdownDate;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

// 提取模型对象里的 owned_by（兼容 ownedBy 驼峰写法）
function parseOwnedBy(m: Record<string, unknown>): string | null {
  const raw = m.owned_by ?? m.ownedBy;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

// 提取模型可用状态（火山方舟返回 status: Available / Unavailable；兼容 state / availability 写法）
function parseStatus(m: Record<string, unknown>): string | null {
  const raw = m.status ?? m.state ?? m.availability;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

// 视频模型功能参数：条目上除标准字段外的其余键值（duration/resolution/fps/audio 等），原样保留
const STANDARD_KEYS = new Set([
  "id",
  "object",
  "created",
  "owned_by",
  "ownedBy",
  "shutdown_date",
  "shutdownDate",
  "type",
  "status",
  "state",
  "availability",
]);
function parseExtraParams(m: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (!STANDARD_KEYS.has(k) && v != null) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// 判定已停用：shutdown_date 存在且日期已过（含当天）；日期无法解析时不作为下线依据
function isShutdown(shutdownDate: string | null): boolean {
  if (!shutdownDate) return false;
  const ts = new Date(shutdownDate).getTime();
  return !Number.isNaN(ts) && ts <= Date.now();
}

// 判定仅内部使用：owned_by 含 internal（如 "openai-internal"，公司内部人员专用，外部调用不了）
function isInternalOnly(ownedBy: string | null): boolean {
  return !!ownedBy && /internal/i.test(ownedBy);
}

// 不可用原因（null = 可用）：上游 status=Unavailable > 待下线(Retiring) > 已过停用日期 > 仅内部可用
// 注意：火山方舟公共目录 GET /models 的 status 取值是 Published / Retiring（生命周期），
// 不是账号权益的 Available / Unavailable（那个来自 ListModelChargeItems）；
// Retiring = 仍可调用但已进入下线流程，默认不作为可入库候选。
type UnavailableReason = "status_unavailable" | "retiring" | "shutdown" | "internal";
function unavailableReasonOf(m: UpstreamModel): UnavailableReason | null {
  if (m.status && /^(unavailable|disabled|inactive|offline)$/i.test(m.status)) return "status_unavailable";
  if (m.status && /^(retiring|retire|deprecated|deprecating)$/i.test(m.status)) return "retiring";
  if (isShutdown(m.shutdownDate)) return "shutdown";
  if (isInternalOnly(m.ownedBy)) return "internal";
  return null;
}

// 候选地址：base 不带 /v1 时两个都试（聚合 AI 两种挂法都常见）
function candidateUrls(base: string, path: string): string[] {
  const b = base.replace(/\/+$/, "");
  return b.endsWith("/v1") ? [`${b}/${path}`] : [`${b}/${path}`, `${b}/v1/${path}`];
}

// GET JSON（Bearer Key），返回解析后的 JSON；失败返回错误
async function fetchJson(apiBase: string, apiKey: string, path: string): Promise<{ ok: true; json: unknown } | { ok: false; error: string; status: number }> {
  const urls = candidateUrls(apiBase, path);
  let lastStatus = 0;
  for (const url of urls) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      return { ok: false, error: `上游请求失败：${(e as Error).message}`, status: 0 };
    }
    lastStatus = res.status;
    if (!res.ok) {
      if (res.status === 404 && url !== urls[urls.length - 1]) continue;
      return { ok: false, error: `上游获取失败：HTTP ${res.status}`, status: res.status };
    }
    try {
      return { ok: true, json: await res.json() };
    } catch {
      return { ok: false, error: `上游响应非 JSON：HTTP ${res.status}`, status: res.status };
    }
  }
  return { ok: false, error: `上游获取失败：HTTP ${lastStatus}`, status: lastStatus };
}

// 模型清单解析（容错：object:list/data、纯数组、{data:[...]}）
function parseModelList(json: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(json)) return json.map((m) => (m ?? {}) as Record<string, unknown>);
  const data = (json as { data?: unknown })?.data;
  if (Array.isArray(data)) return data.map((m) => (m ?? {}) as Record<string, unknown>);
  return null;
}

// 上游模型清单拉取（OpenAI 兼容 GET {base}/models[?type=video]）
async function fetchUpstreamModels(
  apiBase: string,
  apiKey: string,
  query: "" | "type=video"
): Promise<{ ok: true; models: UpstreamModel[] } | { ok: false; error: string }> {
  const path = query ? `models?${query}` : "models";
  const r = await fetchJson(apiBase, apiKey, path);
  if (!r.ok) return { ok: false, error: r.error };
  const data = parseModelList(r.json);
  if (!data) return { ok: false, error: "上游模型清单格式不符：响应缺少 data 数组" };
  const models = data
    .map((obj) => {
      const id = obj.id ?? obj.name;
      return typeof id === "string" && id.length > 0
        ? {
            id,
            shutdownDate: parseShutdownDate(obj),
            ownedBy: parseOwnedBy(obj),
            status: parseStatus(obj),
            params: parseExtraParams(obj),
          }
        : null;
    })
    .filter((m): m is UpstreamModel => m !== null);
  return { ok: true, models };
}

// ─── /models/pricing：全量模型价格（容错解析，供写入成本价） ───
// 计量口径：token 模型按「每 1M tokens」；image/video/request 按「每次/张」
interface PricingEntry {
  model: string;
  input: number | null;
  output: number | null;
  currency: string;
  meterBase: number;
  unit: "token" | "image" | "video_second" | "request";
}

function firstNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const n = firstNumber(obj[k]);
    if (n != null) return n;
  }
  return null;
}

// 计量口径解析：按 per/unit 字符串判定；缺省按模型类型（token 模型 1M tokens，媒体按次）
function parseMeter(
  obj: Record<string, unknown>,
  endpointType: string
): { meterBase: number; unit: "token" | "image" | "video_second" | "request" } {
  // 新式聚合格式：billing_mode 直接决定计量（token=每 1M，per_image=按张，per_call=按次）
  const mode = String(obj.billing_mode ?? "").toLowerCase();
  if (mode === "token") return { meterBase: 1_000_000, unit: "token" };
  if (mode === "per_image" || mode === "image") return { meterBase: 1, unit: "image" };
  if (mode === "per_second") return { meterBase: 1, unit: "video_second" };
  if (mode === "per_call" || mode === "per_request" || mode === "request") return { meterBase: 1, unit: "request" };
  const raw = String(obj.per ?? obj.unit ?? obj.price_unit ?? obj.billing_unit ?? obj.quota_type ?? "").toLowerCase();
  if (/1\s?k|1000(?!0)/.test(raw) && /token/.test(raw)) return { meterBase: 1000, unit: "token" };
  if (/1\s?m|1000000|million/.test(raw) && /token/.test(raw)) return { meterBase: 1_000_000, unit: "token" };
  if (/image|pic|张/.test(raw)) return { meterBase: 1, unit: "image" };
  if (/second|秒/.test(raw)) return { meterBase: 1, unit: "video_second" };
  if (/request|call|次|per_unit|per-call/.test(raw)) return { meterBase: 1, unit: "request" };
  // 缺省：chat/audio 按每 1M tokens，image/video 按每次
  return endpointType === "image"
    ? { meterBase: 1, unit: "image" }
    : endpointType === "video"
      ? { meterBase: 1, unit: "request" }
      : { meterBase: 1_000_000, unit: "token" };
}

function parseCurrency(obj: Record<string, unknown>): string {
  const lc = obj.list_cost && typeof obj.list_cost === "object" && !Array.isArray(obj.list_cost) ? (obj.list_cost as Record<string, unknown>) : {};
  const raw = String(obj.currency ?? obj.curr ?? obj.price_unit ?? lc.currency ?? "").toLowerCase();
  if (/usd|\$/.test(raw)) return "USD";
  if (/cny|rmb|¥|￥/.test(raw)) return "CNY";
  return "CNY";
}

// 单条价格归一（兼容常见聚合 AI 字段名；key 为对象 map 形态时的模型名）
function normalizePricingEntry(
  key: string | null,
  obj: Record<string, unknown>,
  endpointType: string
): PricingEntry | null {
  const model = String(obj.model ?? obj.model_name ?? obj.name ?? obj.id ?? key ?? "").trim();
  if (!model) return null;
  // 新式聚合格式：cost: { input, output }（token 模型，每 1M）+ per_call_tiers（按张/按次分档，取首档）
  const costObj =
    obj.cost && typeof obj.cost === "object" && !Array.isArray(obj.cost) ? (obj.cost as Record<string, unknown>) : null;
  const tiers = Array.isArray(obj.per_call_tiers) ? (obj.per_call_tiers as Record<string, unknown>[]) : [];
  if (costObj || tiers.length > 0) {
    let nIn = costObj ? firstNumber(costObj.input) : null;
    let nOut = costObj ? firstNumber(costObj.output) : null;
    if (tiers.length > 0) {
      const per = firstNumber(tiers[0].cost) ?? firstNumber(tiers[0].list_cost);
      if (per != null) {
        nIn = per;
        nOut = per;
      }
    }
    if (nIn != null || nOut != null) {
      const { meterBase, unit } = parseMeter(obj, endpointType);
      return { model, input: nIn ?? 0, output: nOut ?? 0, currency: parseCurrency(obj), meterBase, unit };
    }
  }
  let input = pickNumber(obj, ["input", "input_price", "inputPrice", "prompt", "prompt_price", "promptPrice", "input_per_1m", "input_1m"]);
  let output = pickNumber(obj, ["output", "output_price", "outputPrice", "completion", "completion_price", "completionPrice", "output_per_1m", "output_1m"]);
  // NewAPI 风格：model_price 为按次价格（quota_type=1），无输入/输出拆分
  if (input == null && output == null) {
    const perCall = pickNumber(obj, ["model_price", "modelPrice", "price"]);
    if (perCall != null) {
      input = perCall;
      output = perCall;
    }
  }
  if (input == null && output == null) return null;
  const { meterBase, unit } = parseMeter(obj, endpointType);
  return { model, input: input ?? 0, output: output ?? 0, currency: parseCurrency(obj), meterBase, unit };
}

// /models/pricing 拉取 + 归一（容错：数组 / data 数组 / 对象 map）
async function fetchUpstreamPricing(
  apiBase: string,
  apiKey: string,
  endpointTypeOf: (name: string) => string
): Promise<{ ok: true; entries: PricingEntry[]; unmatched: number } | { ok: false; error: string }> {
  const r = await fetchJson(apiBase, apiKey, "models/pricing");
  if (!r.ok) return { ok: false, error: r.error };
  const json = r.json;

  const raw: (readonly [string | null, Record<string, unknown>])[] = [];
  const pushList = (arr: unknown[]) => {
    for (const m of arr) raw.push([null, (m ?? {}) as Record<string, unknown>]);
  };
  if (Array.isArray(json)) pushList(json);
  else {
    const data = (json as { data?: unknown })?.data;
    // 新式聚合格式：{ models: [ ... ] }
    const models = (json as { models?: unknown })?.models;
    if (Array.isArray(data)) pushList(data);
    else if (Array.isArray(models)) pushList(models);
    else if (json && typeof json === "object") {
      // 对象 map 形态：{ "model-name": { input, output, ... } }
      for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
        if (v && typeof v === "object" && !Array.isArray(v)) raw.push([k, v as Record<string, unknown>]);
      }
    }
  }

  const entries: PricingEntry[] = [];
  let unmatched = 0;
  for (const [key, obj] of raw) {
    const name = String(obj.model ?? obj.model_name ?? obj.name ?? obj.id ?? key ?? "");
    const e = normalizePricingEntry(key, obj, endpointTypeOf(name));
    if (e) entries.push(e);
    else unmatched += 1;
  }
  return { ok: true, entries, unmatched };
}

// 鉴权 + 取 Key 明文（GET/POST 共用）
async function authorizeAndLoadKey(id: string) {
  const admin = await requireAdmin();
  if (!admin) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  const { user, ok } = await requirePerm(PERMISSIONS.MODELS_WRITE);
  if (!user || !ok) return { error: NextResponse.json({ error: "no permission" }, { status: 403 }) };

  const keyId = Number(id);
  if (!Number.isInteger(keyId)) return { error: NextResponse.json({ error: "参数错误" }, { status: 400 }) };

  const key = await db.vendorApiKey.findUnique({ where: { id: keyId }, include: { vendor: true } });
  if (!key) return { error: NextResponse.json({ error: "Key 不存在" }, { status: 404 }) };

  let apiKey: string;
  try {
    apiKey = decryptSecret(key.keyCipher);
  } catch {
    return { error: NextResponse.json({ error: "Key 解密失败，请检查 STORAGE_KEY_SECRET 配置" }, { status: 500 }) };
  }
  return { admin, key, apiKey };
}

// 端点路径映射：chat → chat_completions；image/video → image_generations；audio 不建
function endpointPathOf(endpointType: string): string | null {
  return endpointType === "chat"
    ? "chat_completions"
    : endpointType === "image" || endpointType === "video"
      ? "image_generations"
      : null;
}

// 合并两个清单（默认 + 视频），同名去重（视频清单的 params 优先保留）
function mergeModels(defaultList: UpstreamModel[], videoList: UpstreamModel[]): UpstreamModel[] {
  const map = new Map<string, UpstreamModel>();
  for (const m of defaultList) map.set(m.id, m);
  for (const m of videoList) {
    const prev = map.get(m.id);
    map.set(m.id, prev ? { ...m, params: m.params ?? prev.params } : m);
  }
  return [...map.values()];
}

// GET /api/admin/models/keys/[id]/fetch-models —— 预览：候选模型清单（只读，含 /models?type=video，不取价）
// GET ...?mode=pricing —— 获取原价预览：/models/pricing 按已入库模型 ID 匹配（须先入库模型）
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeAndLoadKey((await params).id);
  if ("error" in auth) return auth.error;
  const { key, apiKey } = auth;

  // ── 获取原价预览：只按已入库模型匹配价格（模型未获取完成时不允许取价） ──
  if (req.nextUrl.searchParams.get("mode") === "pricing") {
    const modelCount = await db.aiModel.count({ where: { vendorId: key.vendorId } });
    if (modelCount === 0) {
      return NextResponse.json({ error: "该厂商还没有模型：请先用「获取所有模型」入库，再获取原价" }, { status: 400 });
    }
    const pr = await fetchUpstreamPricing(key.vendor.apiBase, apiKey, guessEndpointType);
    if (!pr.ok) return NextResponse.json({ error: pr.error }, { status: 502 });
    const dbModels = await db.aiModel.findMany({
      where: { vendorId: key.vendorId },
      select: { name: true, pricings: { select: { id: true }, take: 1 } },
    });
    const hasPricing = new Map(dbModels.map((m) => [m.name, m.pricings.length > 0]));
    const entries = pr.entries.map((e) => ({
      ...e,
      state: !hasPricing.has(e.model) ? ("notInDb" as const) : hasPricing.get(e.model) ? ("hasPricing" as const) : ("fill" as const),
    }));
    return NextResponse.json({
      ok: true,
      total: pr.entries.length,
      matched: entries.filter((e) => e.state !== "notInDb").length,
      fillable: entries.filter((e) => e.state === "fill").length,
      unmatched: pr.unmatched,
      entries,
    });
  }

  // /models（默认 chat+image）+ /models?type=video（视频模型含功能参数）
  const upstream = await fetchUpstreamModels(key.vendor.apiBase, apiKey, "");
  if (!upstream.ok) return NextResponse.json({ error: upstream.error }, { status: 502 });
  const videoRes = await fetchUpstreamModels(key.vendor.apiBase, apiKey, "type=video");
  const videoModels = videoRes.ok ? videoRes.models : [];
  const merged = mergeModels(upstream.models, videoModels);

  let candidates = 0;
  let availableCount = 0;
  let inDb = 0;
  let skippedUnavailable = 0;
  let toDeactivate = 0;
  const items: {
    name: string;
    endpointType: string;
    path: string | null;
    shutdownDate: string | null;
    ownedBy: string | null;
    status: string | null;
    available: boolean;
    unavailableReason: UnavailableReason | null;
    inDb: boolean;
    dbStatus: string | null;
    videoParams: Record<string, unknown> | null;
  }[] = [];

  // 全量返回上游模型（含已在库 / 不可用），由后台按 Available / Unavailable 筛选后勾选入库；
  // candidates 仅为「可用且未入库」的子集（兼容批量勾选的默认口径）。
  for (const m of merged) {
    const reason = unavailableReasonOf(m);
    const available = reason === null;
    const existing = await db.aiModel.findUnique({
      where: { vendorId_name: { vendorId: key.vendorId, name: m.id } },
    });

    if (available) availableCount += 1;
    if (existing) {
      inDb += 1;
      // 与 POST 同口径：Retiring（待下线）不作为下线标记，避免预览计数与实际入库动作不一致
      if (reason !== null && reason !== "retiring" && existing.status !== "offline") toDeactivate += 1;
    } else if (!available) {
      skippedUnavailable += 1;
    } else {
      candidates += 1;
    }

    // 已在库的用库内端点类型（可能是人工调整过的），否则用启发式判定
    const endpointType = existing ? existing.endpointType : guessEndpointType(m.id);
    items.push({
      name: m.id,
      endpointType,
      path: endpointPathOf(endpointType),
      shutdownDate: m.shutdownDate,
      ownedBy: m.ownedBy,
      status: m.status,
      available,
      unavailableReason: reason,
      inDb: !!existing,
      dbStatus: existing?.status ?? null,
      videoParams: m.params,
    });
  }

  // b15：变更检测（新增 / 下线 / 恢复 / 参数变化），供后台 diff 预览
  const dbRows = await db.aiModel.findMany({
    where: { vendorId: key.vendorId },
    select: { name: true, status: true, advancedConfig: true },
  });
  const diff = computeModelDiff(items, dbRows);

  return NextResponse.json({
    ok: true,
    total: merged.length,
    counts: { candidates, available: availableCount, inDb, skippedUnavailable, toDeactivate },
    candidates: items.filter((i) => i.available && !i.inDb),
    items,
    diff,
    videoSource: videoRes.ok ? "ok" : "unavailable",
  });
}

// /models/pricing → 成本价：按已入库模型 ID 匹配填入（仅补「尚无定价」的模型，不覆盖已有调价）
async function fillPricesFromUpstream(
  key: { vendorId: number; vendor: { apiBase: string } },
  apiKey: string,
  fxRate: number
): Promise<{ filled: number; skippedHasPricing: number; noMatch: number }> {
  let filled = 0;
  let skippedHasPricing = 0;
  let noMatch = 0;
  const pr = await fetchUpstreamPricing(key.vendor.apiBase, apiKey, guessEndpointType);
  if (!pr.ok) return { filled, skippedHasPricing, noMatch: 0 };
  for (const e of pr.entries) {
    const model = await db.aiModel.findUnique({
      where: { vendorId_name: { vendorId: key.vendorId, name: e.model } },
      include: { pricings: { take: 1 } },
    });
    if (!model) {
      noMatch += 1;
      continue;
    }
    if (model.pricings.length > 0) {
      skippedHasPricing += 1;
      continue;
    }
    await db.modelPricing.create({
      data: {
        modelId: model.id,
        meterBase: e.meterBase,
        unit: e.unit,
        inputPrice: e.input ?? 0,
        outputPrice: e.output ?? 0,
        currency: e.currency,
        // USD 按汇率放大 1e8 存快照（计费时自动换算 RMB）；CNY 为 1e8
        fxRateE8: BigInt(Math.round((e.currency === "USD" ? fxRate : 1) * 1e8)),
        multiplierBps: 15000,
        effectiveAt: new Date(),
      },
    });
    filled += 1;
  }
  return { filled, skippedHasPricing, noMatch };
}

// POST /api/admin/models/keys/[id]/fetch-models —— 勾选入库（可选 applyPricing 写入成本价）
// body: { mode: "pricing" } —— 获取原价（独立动作）：不入库，按已入库模型 ID 匹配填价
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeAndLoadKey((await params).id);
  if ("error" in auth) return auth.error;
  const { admin, key, apiKey } = auth;

  // 勾选的模型名（只允许入库预览口径的候选：可用且原本未入库）
  let names: string[] = [];
  let applyPricing = false;
  let pricingOnly = false;
  // 汇率默认用汇率表（fx_rate）里的 USD，body 传 fxRate 可临时覆盖
  const fxRow = await db.fxRate.findUnique({ where: { currency: "USD" } });
  let fxRate = fxRow ? Number(fxRow.rateE8) / 1e8 : 7.15;
  let createAll = false;
  // b15：一键应用「恢复上线」的已下线模型
  let restoreNames: string[] = [];
  try {
    const body = (await req.json()) as {
      mode?: unknown;
      names?: unknown;
      applyPricing?: unknown;
      fxRate?: unknown;
      createAll?: unknown;
      restoreNames?: unknown;
    };
    if (Array.isArray(body?.names)) {
      names = body.names.filter((n): n is string => typeof n === "string" && n.length > 0);
    }
    if (Array.isArray(body?.restoreNames)) {
      restoreNames = body.restoreNames.filter((n): n is string => typeof n === "string" && n.length > 0);
    }
    applyPricing = body?.applyPricing === true;
    pricingOnly = body?.mode === "pricing";
    createAll = body?.createAll === true;
    const fx = Number(body?.fxRate);
    if (Number.isFinite(fx) && fx > 0 && fx < 100) fxRate = fx;
  } catch {
    /* body 解析失败按空处理 */
  }

  // ── 获取原价（独立动作）：不入库，只按已入库模型 ID 匹配填入成本价 ──
  if (pricingOnly || (applyPricing && names.length === 0 && !createAll && restoreNames.length === 0)) {
    const modelCount = await db.aiModel.count({ where: { vendorId: key.vendorId } });
    if (modelCount === 0) {
      return NextResponse.json({ error: "该厂商还没有模型：请先用「获取所有模型」入库，再获取原价" }, { status: 400 });
    }
    const r = await fillPricesFromUpstream(key, apiKey, fxRate);
    await logAdminAction({
      adminId: admin.id,
      action: "fetch_pricing",
      targetType: "vendor_api_key",
      targetId: key.id,
      detail: JSON.stringify({ vendor: key.vendor.name, keyPrefix: key.keyPrefix, ...r }),
      ip: await getClientIp(),
    });
    return NextResponse.json({ ok: true, ...r });
  }

  if (names.length === 0 && !createAll && restoreNames.length === 0) {
    return NextResponse.json({ error: "请勾选要入库的模型" }, { status: 400 });
  }
  const selected = new Set(names);
  const restoreSet = new Set(restoreNames);

  const upstream = await fetchUpstreamModels(key.vendor.apiBase, apiKey, "");
  if (!upstream.ok) return NextResponse.json({ error: upstream.error }, { status: 502 });
  const videoRes = await fetchUpstreamModels(key.vendor.apiBase, apiKey, "type=video");
  const merged = mergeModels(upstream.models, videoRes.ok ? videoRes.models : []);

  let created = 0;
  let kept = 0;
  let deactivated = 0;
  let restored = 0;
  let skipped = 0;
  let unselected = 0;
  const items: {
    name: string;
    endpointType: string;
    state: "created" | "kept" | "deactivated" | "restored" | "skipped" | "unselected";
    shutdownDate: string | null;
    ownedBy: string | null;
  }[] = [];

  for (const m of merged) {
    const name = m.id;
    const { shutdownDate, ownedBy, params: extra } = m;
    // 不可用 = 上游 status=Unavailable / 已过停用日期 / 仅内部使用（owned_by 含 internal，外部调用不了）
    // Retiring（待下线）只影响「是否作为新候选入库」，不自动把已在库模型置 offline，避免误停线上流量
    const reason = unavailableReasonOf(m);
    const unavailable = reason !== null;
    const shouldDeactivate = reason !== null && reason !== "retiring";
    const existing = await db.aiModel.findUnique({
      where: { vendorId_name: { vendorId: key.vendorId, name } },
    });

    if (existing) {
      if (shouldDeactivate && existing.status !== "offline") {
        // 已存在但上游不可用 → 标记下线（同步可用性，不动定价/端点等其余配置）
        await db.aiModel.update({ where: { id: existing.id }, data: { status: "offline" } });
        deactivated += 1;
        items.push({ name, endpointType: existing.endpointType, state: "deactivated", shutdownDate, ownedBy });
      } else if (!unavailable && existing.status === "offline" && restoreSet.has(name)) {
        // b15：上游恢复可用且勾选了「恢复」→ 重新上线
        await db.aiModel.update({ where: { id: existing.id }, data: { status: "online" } });
        restored += 1;
        items.push({ name, endpointType: existing.endpointType, state: "restored", shutdownDate, ownedBy });
      } else {
        // 已存在且可用（或本就 offline）→ 不动（不覆盖 status/pricing/displayName/endpointType）
        kept += 1;
        items.push({ name, endpointType: existing.endpointType, state: "kept", shutdownDate, ownedBy });
      }
      continue;
    }

    if (unavailable) {
      // 上游不可用的模型不入库
      skipped += 1;
      items.push({ name, endpointType: "-", state: "skipped", shutdownDate, ownedBy });
      continue;
    }

    if (!createAll && !selected.has(name)) {
      // 可用但未勾选 → 本次不入库
      unselected += 1;
      items.push({ name, endpointType: "-", state: "unselected", shutdownDate, ownedBy });
      continue;
    }

    const endpointType = guessEndpointType(name);
    // v0.113：视频功能参数完整写入「高级配置」（advancedConfig，Text 无限长）；
    // 之前塞 remark 且 slice(0,500) 导致 JSON 截断不完整（存量数据已迁移）
    const advancedConfig: string | null = extra ? JSON.stringify(extra) : null;
    const model = await db.aiModel.create({
      data: {
        vendorId: key.vendorId,
        name,
        displayName: name,
        endpointType,
        status: "online",
        remark: null,
        advancedConfig,
      },
    });
    const path = endpointPathOf(endpointType);
    if (path) {
      await db.modelEndpoint.create({ data: { modelId: model.id, path, enabled: true } });
    }
    created += 1;
    items.push({ name, endpointType, state: "created", shutdownDate, ownedBy });
  }

  // ─── applyPricing（建 Key 自动获取流程）：入库后顺带补价（模型在前、价格在后） ───
  let priced = 0;
  let pricingNoMatch = 0;
  if (applyPricing) {
    const r = await fillPricesFromUpstream(key, apiKey, fxRate);
    priced = r.filled;
    pricingNoMatch = r.skippedHasPricing + r.noMatch;
  }

  await logAdminAction({
    adminId: admin.id,
    action: "fetch_models",
    targetType: "vendor_api_key",
    targetId: key.id,
    detail: JSON.stringify({
      vendor: key.vendor.name,
      keyPrefix: key.keyPrefix,
      total: items.length,
      selected: names.length,
      created,
      kept,
      deactivated,
      restored,
      skipped,
      unselected,
      applyPricing,
      priced,
    }),
    ip: await getClientIp(),
  });

  return NextResponse.json({
    ok: true,
    total: items.length,
    created,
    kept,
    deactivated,
    restored,
    skipped,
    unselected,
    priced,
    pricingNoMatch,
    items,
  });
}
