import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { PERMISSIONS, requirePerm, logAdminAction, getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// ─── 获取所有模型：预览上游可用模型清单 + 勾选入库 ───
// GET  /api/admin/models/keys/[id]/fetch-models
//   预览（只读）：用该 Key 调上游 OpenAI 兼容 GET /models，返回「可用且未入库」的候选模型清单
//   （含启发式 endpointType / 端点 path），以及汇总计数（候选 / 已在库 / 跳过已停用 / 将标记下线）
// POST /api/admin/models/keys/[id]/fetch-models   body: { names: string[] }
//   勾选入库：仅创建勾选的候选模型（@@unique([vendorId,name]) 幂等），同时同步已在库模型的可用性：
//   不可用模型（shutdown_date 已过 = 已停用；owned_by 含 internal = 仅内部使用外部调不了）：
//     库里没有 → 不入库（跳过）；库里已有 → 标记 status=offline（同步可用性）
//   可用模型：勾选且不存在 → 创建（含启发式 endpointType + 对应 ModelEndpoint，不建 ModelPricing）
//             未勾选 → 不入库；已存在 → 不动（不覆盖 status/pricing/displayName/endpointType）

// 端点类型启发式判定（按 image → video → audio 顺序匹配，默认 chat）
function guessEndpointType(name: string): "chat" | "image" | "video" | "audio" {
  const n = name.toLowerCase();
  if (/dall-e|image|flux|seedream|stable-diffusion|midjourney|\bsd[-_ ]?\d/.test(n)) return "image";
  if (/sora|video|veo|kling|runway|pika|hailuo|wan|keling/.test(n)) return "video";
  if (/whisper|tts|speech|audio/.test(n)) return "audio";
  return "chat";
}

// 上游模型条目：id + 停用日期 + 归属（owned_by，含 internal = 仅内部使用，外部调不了）
interface UpstreamModel {
  id: string;
  shutdownDate: string | null;
  ownedBy: string | null;
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

// 上游模型清单拉取（OpenAI 兼容 GET {base}/models）
async function fetchUpstreamModels(apiBase: string, apiKey: string): Promise<{ ok: true; models: UpstreamModel[] } | { ok: false; error: string }> {
  const base = apiBase.replace(/\/+$/, "");
  const urls = base.endsWith("/v1") ? [`${base}/models`] : [`${base}/models`, `${base}/v1/models`];

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
      return { ok: false, error: `上游模型清单请求失败：${(e as Error).message}` };
    }
    lastStatus = res.status;
    if (!res.ok) {
      // 404 时换下一个候选地址重试，其余状态码直接报 502
      if (res.status === 404 && url !== urls[urls.length - 1]) continue;
      return { ok: false, error: `上游模型清单获取失败：HTTP ${res.status}` };
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: `上游模型清单格式不符：HTTP ${res.status} 非 JSON 响应` };
    }
    const data = (json as { object?: unknown; data?: unknown })?.data;
    if ((json as { object?: unknown })?.object !== "list" || !Array.isArray(data)) {
      return { ok: false, error: `上游模型清单格式不符：HTTP ${res.status} 响应缺少 object:list/data 数组` };
    }
    const models = data
      .map((m) => {
        const obj = (m ?? {}) as Record<string, unknown>;
        const id = obj.id;
        return typeof id === "string" && id.length > 0
          ? { id, shutdownDate: parseShutdownDate(obj), ownedBy: parseOwnedBy(obj) }
          : null;
      })
      .filter((m): m is UpstreamModel => m !== null);
    return { ok: true, models };
  }
  return { ok: false, error: `上游模型清单获取失败：HTTP ${lastStatus}` };
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

// GET /api/admin/models/keys/[id]/fetch-models —— 预览：返回可用且未入库的候选模型清单（只读）
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeAndLoadKey((await params).id);
  if ("error" in auth) return auth.error;
  const { key, apiKey } = auth;

  const upstream = await fetchUpstreamModels(key.vendor.apiBase, apiKey);
  if (!upstream.ok) return NextResponse.json({ error: upstream.error }, { status: 502 });

  let candidates = 0;
  let inDb = 0;
  let skippedUnavailable = 0;
  let toDeactivate = 0;
  const items: {
    name: string;
    endpointType: string;
    path: string | null;
    shutdownDate: string | null;
    ownedBy: string | null;
  }[] = [];

  for (const { id: name, shutdownDate, ownedBy } of upstream.models) {
    const unavailable = isShutdown(shutdownDate) || isInternalOnly(ownedBy);
    const existing = await db.aiModel.findUnique({
      where: { vendorId_name: { vendorId: key.vendorId, name } },
    });

    if (existing) {
      inDb += 1;
      if (unavailable && existing.status !== "offline") toDeactivate += 1;
      continue;
    }
    if (unavailable) {
      skippedUnavailable += 1;
      continue;
    }
    // 可用且未入库 → 候选，供勾选入库
    const endpointType = guessEndpointType(name);
    candidates += 1;
    items.push({ name, endpointType, path: endpointPathOf(endpointType), shutdownDate, ownedBy });
  }

  return NextResponse.json({
    ok: true,
    total: upstream.models.length,
    counts: { candidates, inDb, skippedUnavailable, toDeactivate },
    candidates: items,
  });
}

// POST /api/admin/models/keys/[id]/fetch-models —— 勾选入库：仅创建勾选的候选模型 + 同步已在库可用性
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeAndLoadKey((await params).id);
  if ("error" in auth) return auth.error;
  const { admin, key, apiKey } = auth;

  // 勾选的模型名（只允许入库预览口径的候选：可用且原本未入库）
  let names: string[] = [];
  try {
    const body = (await req.json()) as { names?: unknown };
    if (Array.isArray(body?.names)) {
      names = body.names.filter((n): n is string => typeof n === "string" && n.length > 0);
    }
  } catch {
    /* body 解析失败按空处理 */
  }
  if (names.length === 0) {
    return NextResponse.json({ error: "请勾选要入库的模型" }, { status: 400 });
  }
  const selected = new Set(names);

  const upstream = await fetchUpstreamModels(key.vendor.apiBase, apiKey);
  if (!upstream.ok) return NextResponse.json({ error: upstream.error }, { status: 502 });

  let created = 0;
  let kept = 0;
  let deactivated = 0;
  let skipped = 0;
  let unselected = 0;
  const items: {
    name: string;
    endpointType: string;
    state: "created" | "kept" | "deactivated" | "skipped" | "unselected";
    shutdownDate: string | null;
    ownedBy: string | null;
  }[] = [];

  for (const { id: name, shutdownDate, ownedBy } of upstream.models) {
    // 不可用 = 已过停用日期，或仅内部使用（owned_by 含 internal，外部调用不了）
    const unavailable = isShutdown(shutdownDate) || isInternalOnly(ownedBy);
    const existing = await db.aiModel.findUnique({
      where: { vendorId_name: { vendorId: key.vendorId, name } },
    });

    if (existing) {
      if (unavailable && existing.status !== "offline") {
        // 已存在但上游不可用 → 标记下线（同步可用性，不动定价/端点等其余配置）
        await db.aiModel.update({ where: { id: existing.id }, data: { status: "offline" } });
        deactivated += 1;
        items.push({ name, endpointType: existing.endpointType, state: "deactivated", shutdownDate, ownedBy });
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

    if (!selected.has(name)) {
      // 可用但未勾选 → 本次不入库
      unselected += 1;
      items.push({ name, endpointType: "-", state: "unselected", shutdownDate, ownedBy });
      continue;
    }

    const endpointType = guessEndpointType(name);
    const model = await db.aiModel.create({
      data: {
        vendorId: key.vendorId,
        name,
        displayName: name,
        endpointType,
        status: "online",
      },
    });
    const path = endpointPathOf(endpointType);
    if (path) {
      await db.modelEndpoint.create({ data: { modelId: model.id, path, enabled: true } });
    }
    // 不创建 ModelPricing（管理员后续配置）
    created += 1;
    items.push({ name, endpointType, state: "created", shutdownDate, ownedBy });
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
      skipped,
      unselected,
    }),
    ip: await getClientIp(),
  });

  return NextResponse.json({ ok: true, total: items.length, created, kept, deactivated, skipped, unselected, items });
}
