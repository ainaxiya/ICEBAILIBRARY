import type { AiModel, AiVendor, ModelEndpoint, ModelPricing } from "@prisma/client";
import { decryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { getSharedRedis } from "@/lib/redis";
import { latestPricing } from "./pricing";

// ─── P1 聚合网关：Key 路由（厂商级 Key 池） ───
// P2 渠道健康：被动熔断（滑动窗口 → open → 半开探测恢复）+ 加权随机选路。
// 健康态为进程内存（单实例足够；多实例前迁 Redis，见看板 #7）。
// 不做主动探测（真实调用会产生费用），靠真实流量被动统计——方案 8.3 的务实实现。

export interface KeyCandidate {
  vendorKeyId: number; // VendorApiKey.id（写入 usage_record.vendor_key_id）
  keyName: string;
  apiKey: string; // 解密后的明文 Key（内存中用完即弃，不落日志）
  apiBase: string;
  protocol: string; // 厂商上游协议（AiVendor.protocol：openai | anthropic | gemini | ark …）
}

export interface RouteContext {
  model: AiModel;
  vendor: AiVendor;
  endpoints: ModelEndpoint[];
  pricings: ModelPricing[];
  pricing: ModelPricing | null;
  candidates: KeyCandidate[];
}

// ─── 熔断状态机（per vendorKeyId） ───

interface AttemptRecord {
  ok: boolean;
  status: number;
  at: number;
}

interface KeyHealth {
  window: AttemptRecord[];
  state: "closed" | "open" | "half-open";
  openedAt: number;
  halfOpenProbes: number;
}

const WINDOW_MS = 60_000; // 滑动窗口时长
const WINDOW_MAX = 20; // 窗口最多记录条数（防内存膨胀）
const FAIL_RATE = 0.5; // 失败率阈值
const MIN_SAMPLES = 5; // 触发熔断的最小样本数
const OPEN_COOLDOWN_MS = 60_000; // open → half-open 冷却
const HALF_OPEN_PROBES = 1; // 半开期放行的探测请求数

const health = new Map<number, KeyHealth>();

// ─── o4：Key 解密失败计数 ───
// STORAGE_KEY_SECRET 变更 / 缺失回退错误会让密文解不开，原实现静默跳过该 Key，
// 运营侧看不到。这里按 vendorKeyId 计数（进程内存），由 keys API 暴露到 Key 健康列。
const decryptFailures = new Map<number, { count: number; lastAt: number }>();

function recordKeyDecryptFailure(vendorKeyId: number): void {
  const cur = decryptFailures.get(vendorKeyId);
  decryptFailures.set(vendorKeyId, { count: (cur?.count ?? 0) + 1, lastAt: Date.now() });
}

// ─── g15 / o13：熔断状态跨实例共享 ───
// 本实例保留进程内状态机做决策（选路/半开探测是同步热路径），
// 状态迁移通过 write-through 写入 Redis；每次选路前 hydrate 一次，把别实例已熔断的
// Key 同步过来。Redis 不可用时退化为纯进程内（与原行为一致）。
const HEALTH_KEY = "gw:keyhealth";

// 选路前同步：只同步 open/closed 状态与打开时间，窗口样本仍按实例统计。
export async function hydrateKeyHealth(ids: number[]): Promise<void> {
  const r = getSharedRedis();
  if (!r || !ids.length) return;
  try {
    const vals = await r.hmget(HEALTH_KEY, ...ids.map(String));
    ids.forEach((id, i) => {
      const raw = vals[i];
      if (!raw) return;
      const remote = JSON.parse(raw) as { state?: string; openedAt?: number };
      const local = healthOf(id);
      const openedAt = Number(remote.openedAt) || 0;
      if (remote.state === "open" && openedAt > local.openedAt) {
        local.state = "open";
        local.openedAt = openedAt;
        local.halfOpenProbes = 0;
      } else if (remote.state === "closed" && local.state === "open") {
        local.state = "closed";
        local.window = [];
        local.halfOpenProbes = 0;
      }
    });
  } catch {
    // Redis 抖动：沿用本实例状态
  }
}

// write-through：状态迁移后异步落共享存储（失败不影响主流程）
function persistHealth(vendorKeyId: number): void {
  const r = getSharedRedis();
  const h = health.get(vendorKeyId);
  if (!r || !h) return;
  if (h.state === "closed") {
    r.hdel(HEALTH_KEY, String(vendorKeyId)).catch(() => {});
    return;
  }
  r.hset(
    HEALTH_KEY,
    String(vendorKeyId),
    JSON.stringify({ state: h.state, openedAt: h.openedAt })
  ).catch(() => {});
}

// 401/403 = Key 失效，立即熔断（方案 7.4：不对同渠道重试）
const IMMEDIATE_OPEN_STATUS = new Set([401, 403]);

// ─── 健康样本口径（U1）───
// 只有「上游或 Key 侧」的失败才代表渠道不健康：
//   status=0     网络异常 / 上游任务失败 / 等待超时（adapter 兜底）
//   2xx/3xx      上游返回了成功码但没有有效产物，或重定向异常 → 上游契约问题
//   5xx          上游故障
//   401/403      Key 失效 / 无权限（必须计入，且立即熔断）
//   408 429      上游超时 / 限流额度耗尽（Key 容量问题，必须计入）
// 其余 4xx（400/404/413/415/422 等）是请求内容被上游拒绝——换 Key 也不会好，
// 由客户端修正请求即可。把它们计入健康分会让任何人用违章请求打穿整个 Key 池。
function isHealthRelevantFailure(status: number): boolean {
  if (status < 400) return true;
  if (status >= 500) return true;
  return status === 401 || status === 403 || status === 408 || status === 429;
}

function healthOf(id: number): KeyHealth {
  let h = health.get(id);
  if (!h) {
    h = { window: [], state: "closed", openedAt: 0, halfOpenProbes: 0 };
    health.set(id, h);
  }
  return h;
}

function failRateOf(h: KeyHealth): number {
  if (h.window.length < MIN_SAMPLES) return 0;
  const fails = h.window.filter((r) => !r.ok).length;
  return fails / h.window.length;
}

// 记录一次上游调用结果（成功/失败 + HTTP 状态码）
export function recordKeyOutcome(vendorKeyId: number, ok: boolean, status = 200): void {
  const hr = health.get(vendorKeyId);
  if (!ok && !isHealthRelevantFailure(status)) {
    // 客户端侧错误（参数/内容审核等）：不是渠道质量信号，不占样本、不推高失败率。
    // 若正处在半开探测，归还探测名额，避免 Key 因一次坏请求被永久留在 half-open。
    if (hr && hr.state === "half-open") hr.halfOpenProbes = 0;
    return;
  }
  const h = healthOf(vendorKeyId);
  const now = Date.now();
  h.window.push({ ok, status, at: now });
  while (h.window.length > WINDOW_MAX || (h.window.length > 0 && now - h.window[0].at > WINDOW_MS * 5)) {
    h.window.shift();
  }

  if (!ok && IMMEDIATE_OPEN_STATUS.has(status)) {
    h.state = "open";
    h.openedAt = now;
    h.halfOpenProbes = 0;
    persistHealth(vendorKeyId);
    return;
  }

  if (h.state === "half-open") {
    if (ok) {
      h.state = "closed";
      h.window = [];
      h.halfOpenProbes = 0;
    } else {
      h.state = "open";
      h.openedAt = now;
      h.halfOpenProbes = 0;
    }
    persistHealth(vendorKeyId);
    return;
  }

  if (h.state === "closed" && !ok && failRateOf(h) >= FAIL_RATE) {
    h.state = "open";
    h.openedAt = now;
    h.halfOpenProbes = 0;
    persistHealth(vendorKeyId);
  }
}

// 归还半开探测名额（取消、异常兜底等「没有形成上游结论」的退出路径）。
// 只有 half-open 态需要归还；closed/open 态本就不占名额。
export function releaseKeyProbe(vendorKeyId: number): void {
  const h = health.get(vendorKeyId);
  if (!h) return;
  if (h.state === "half-open") h.halfOpenProbes = 0;
}

// 客户端主动取消（关页面/点停止）：不计入失败样本，也不推高失败率。
// 仅归还半开探测名额，避免取消把 Key 卡死在 half-open。
export function recordKeyCancelled(vendorKeyId: number): void {
  releaseKeyProbe(vendorKeyId);
}

// 该 Key 当前是否可被选路（纯只读，不占用半开探测名额）。
// U2：选路/健康展示（resolveRoute、vendorHasAvailableKey、/v1/models）只读状态；
// 真正发起上游调用前必须再调 tryAcquireKeyCall 占名额，否则「只选路不调用」会把
// 半开期的唯一探测名额消耗掉，Key 永久退池直到进程重启。
export function keyIsAvailable(vendorKeyId: number): boolean {
  const h = health.get(vendorKeyId);
  if (!h || h.state === "closed") return true;
  if (h.state === "open") {
    // 冷却已到：对选路表现为「可恢复」，但保持 open 态，等真正调用时再转 half-open
    return Date.now() - h.openedAt >= OPEN_COOLDOWN_MS;
  }
  return h.halfOpenProbes < HALF_OPEN_PROBES;
}

// 真正发起上游调用前占用探测名额。
// 返回 false 表示该 Key 的半开名额已被别的真实请求占走，本次应跳过它换下一个 Key。
// 占用后无论成功/失败/取消/异常，都必须经由 recordKeyOutcome / recordKeyCancelled /
// releaseKeyProbe 之一归还（调用点用 finally 兜底）。
export function tryAcquireKeyCall(vendorKeyId: number): boolean {
  const h = health.get(vendorKeyId);
  if (!h || h.state === "closed") return true;
  if (h.state === "open") {
    if (Date.now() - h.openedAt < OPEN_COOLDOWN_MS) return false;
    h.state = "half-open";
    h.halfOpenProbes = 0;
  }
  if (h.halfOpenProbes >= HALF_OPEN_PROBES) return false;
  h.halfOpenProbes += 1;
  return true;
}

// P5 健康度快照（后台运营面板展示用，只读不影响选路）
export function keyHealthSnapshot(vendorKeyId: number): {
  state: "closed" | "open" | "half-open";
  samples: number;
  failRate: number;
  decryptFailures: number;
  lastDecryptFailureAt: number | null;
} {
  const df = decryptFailures.get(vendorKeyId);
  const base = { decryptFailures: df?.count ?? 0, lastDecryptFailureAt: df?.lastAt ?? null };
  const h = health.get(vendorKeyId);
  if (!h) return { state: "closed", samples: 0, failRate: 0, ...base };
  return {
    state: h.state,
    samples: h.window.length,
    failRate: Math.round(failRateOf(h) * 100),
    ...base,
  };
}

// 清除某 Key 的健康态（后台重新启用 Key 时调用）
export function resetKeyHealth(vendorKeyId: number): void {
  health.delete(vendorKeyId);
  decryptFailures.delete(vendorKeyId);
}

// 加权随机排序（weight ≥ 1；同权重保持原有 lastUsedAt 轮换顺序语义）
export function weightedOrder<T extends { weight: number }>(items: T[]): T[] {
  const pool = items.map((it) => ({ it, w: Math.max(1, it.weight) }));
  const out: T[] = [];
  while (pool.length) {
    const total = pool.reduce((s, p) => s + p.w, 0);
    let roll = Math.random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      roll -= pool[i].w;
      if (roll < 0) {
        idx = i;
        break;
      }
    }
    out.push(pool[idx].it);
    pool.splice(idx, 1);
  }
  return out;
}

// 解析模型路由：null = 模型不存在或已下线
// 计价口径锁定：modelName 必须是客户端原始请求的模型名（body.model），
// 只按 AiModel.name 精确匹配，绝不走 displayName / 上游别名反查，
// 返回的 pricing 也只取该模型行自己的定价（不做跨模型/跨厂商换名）。
// orderBy id：同名模型若在多家厂商各建了一行（@@unique([vendorId, name]) 允许），
// 固定取最小 id 那一行，避免 findFirst 随执行计划漂移导致同一请求按不同价收费。
export async function resolveRoute(modelName: string): Promise<RouteContext | null> {
  const model = await db.aiModel.findFirst({
    where: { name: modelName, status: "online" },
    orderBy: { id: "asc" },
    include: {
      vendor: true,
      endpoints: true,
      pricings: true,
    },
  });
  if (!model) return null;

  // 厂商级 Key 池：active → 熔断过滤 → 加权随机排序
  const keys = await db.vendorApiKey.findMany({
    where: { vendorId: model.vendorId, status: "active" },
  });

  // g15/o13：把其它实例的熔断结果同步到本实例（Redis 不可用则为 no-op）
  await hydrateKeyHealth(keys.map((k) => k.id));

  const candidates: KeyCandidate[] = [];
  const weighted: { cand: KeyCandidate; weight: number }[] = [];
  const now = new Date();
  for (const k of keys) {
    if (!keyIsAvailable(k.id)) continue; // 熔断中的 Key 不参与选路
    // P5 维护窗口：维护中（maintainUntil 未到）不参与选路
    if (k.maintainUntil && k.maintainUntil.getTime() > now.getTime()) continue;
    try {
      weighted.push({
        cand: {
          vendorKeyId: k.id,
          keyName: k.name,
          apiKey: decryptSecret(k.keyCipher),
          apiBase: model.vendor.apiBase,
          protocol: model.vendor.protocol,
        },
        weight: k.weight,
      });
    } catch {
      // 密钥解密失败（如 STORAGE_KEY_SECRET 变更）：跳过该 Key，走下一个
      recordKeyDecryptFailure(k.id);
    }
  }

  for (const { cand } of weightedOrder(weighted)) {
    candidates.push(cand);
  }

  return {
    model,
    vendor: model.vendor,
    endpoints: model.endpoints,
    pricings: model.pricings,
    pricing: latestPricing(model),
    candidates,
  };
}

// 队列消费者按 Key id 复原候选（队列载荷只传 id，不传明文 Key）。
// 入队时已排好顺序，这里按传入顺序还原；期间被禁用 / 解密失败的 Key 跳过。
export async function loadKeyCandidatesByIds(vendorKeyIds: number[]): Promise<KeyCandidate[]> {
  if (!vendorKeyIds.length) return [];
  const keys = await db.vendorApiKey.findMany({
    where: { id: { in: vendorKeyIds } },
    include: { vendor: true },
  });
  const byId = new Map(keys.map((k) => [k.id, k]));
  const out: KeyCandidate[] = [];
  for (const id of vendorKeyIds) {
    const k = byId.get(id);
    if (!k || k.status !== "active") continue;
    try {
      out.push({
        vendorKeyId: k.id,
        keyName: k.name,
        apiKey: decryptSecret(k.keyCipher),
        apiBase: k.vendor.apiBase,
        protocol: k.vendor.protocol,
      });
    } catch {
      // 密文无法解密（历史密钥变更）：跳过该 Key，交给后续候选
      recordKeyDecryptFailure(k.id);
    }
  }
  return out;
}

// 选中 Key 后回写 lastUsedAt（fire-and-forget，不阻塞调用）
export function markKeyUsed(vendorKeyId: number) {
  db.vendorApiKey
    .update({ where: { id: vendorKeyId }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
}

// 模型是否至少有一把可用（未熔断）的 active Key —— /v1/models 健康过滤用
export function vendorHasAvailableKey(keys: { id: number; status: string }[]): boolean {
  return keys.some((k) => k.status === "active" && keyIsAvailable(k.id));
}
