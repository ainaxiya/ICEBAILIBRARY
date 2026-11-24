// ─── 实验场运营配置（pa 组口径，存 SiteSetting，不新增库表/列） ───
// 1) 游客试玩开关 + 可试玩次数（默认关闭）
// 2) 默认图片 / 视频模型（全开，不做白名单，只定默认值）
// 3) 会员参数「锁定为默认」开关
// 4) 参考素材上限（只能在模型能力内下调，超出按模型上限截断）
// 读取失败一律回落安全默认：游客关闭、不锁参数、不额外限制素材。

import { db } from "@/lib/db";

export const SETTING_KEYS = {
  guest: "playground_guest_trial",
  defaults: "playground_defaults",
  lock: "playground_param_lock",
  limits: "playground_reference_limits",
  upload: "playground_upload_limits",
  copy: "playground_task_copy",
  notice: "playground_rate_limit_notice",
  persona: "playground_persona",
  enabled: "playground_enabled",
} as const;

// ── 游客试玩 ──
export interface GuestTrialConfig {
  enabled: boolean;
  maxTrials: number;
}

export const DEFAULT_GUEST_TRIAL: GuestTrialConfig = { enabled: false, maxTrials: 3 };
export const MAX_GUEST_TRIALS = 50;

// ── 默认模型 ──
export interface DefaultModels {
  image: string;
  video: string;
}

export const DEFAULT_MODELS: DefaultModels = {
  image: "gpt-image-2",
  video: "doubao-seedance-2-5",
};

// ── 参数锁定 ──
export interface ParamPolicy {
  lockDefaults: boolean;
}

export const DEFAULT_PARAM_POLICY: ParamPolicy = { lockDefaults: false };

// ── 参考素材上限（null = 按模型能力上限，不额外限制） ──
export interface ReferenceLimits {
  maxReferenceImages: number | null;
  maxReferenceVideos: number | null;
}

export const DEFAULT_REFERENCE_LIMITS: ReferenceLimits = {
  maxReferenceImages: null,
  maxReferenceVideos: null,
};

// 模型能力矩阵里的硬上限：后台只能在 0…该值之间下调，不能调高
export const HARD_MAX_REFERENCE_IMAGES = 30;
export const HARD_MAX_REFERENCE_VIDEOS = 10;

// ── 上传格式与体积上限（pa25） ──
// 只允许收窄：格式按文件头识别结果匹配，体积上限不得超过程序硬上限。
// 图片 kind：jpg / png / webp / gif；视频 kind：mp4（含 MOV）/ webm。
export const IMAGE_FORMAT_OPTIONS = ["jpg", "png", "webp", "gif"] as const;
export const VIDEO_FORMAT_OPTIONS = ["mp4", "webm"] as const;
export const HARD_MAX_IMAGE_MB = 50;
export const HARD_MAX_VIDEO_MB = 500;

export interface UploadLimits {
  imageMaxMB: number;
  videoMaxMB: number;
  imageFormats: string[];
  videoFormats: string[];
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  imageMaxMB: 10,
  videoMaxMB: 100,
  imageFormats: [...IMAGE_FORMAT_OPTIONS],
  videoFormats: [...VIDEO_FORMAT_OPTIONS],
};

export interface PlaygroundSettings {
  guest: GuestTrialConfig;
  defaultModels: DefaultModels;
  paramPolicy: ParamPolicy;
  limits: ReferenceLimits;
  upload: UploadLimits;
  copy: TaskCopy;
  rateLimitNotice: string;
  // pa8 平台级人设提示词：空 = 使用通用系统提示，不额外注入
  persona: string;
  // pa1 实验场总开关：false = 入口隐藏 + 接口拒绝；未配置默认开启
  enabled: boolean;
}

// ── pa1 实验场总开关：与维护模式区分（维护=停接新任务但入口仍在） ──
export const DEFAULT_ENABLED = true;

export function normalizeEnabled(input: unknown): boolean {
  return input === false ? false : true;
}

// 布局层轻量读取：只查一个键，避免每页都跑整套设置
export async function getPlaygroundEnabled(): Promise<boolean> {
  try {
    const row = await db.siteSetting.findUnique({
      where: { key: SETTING_KEYS.enabled },
      select: { value: true },
    });
    if (!row) return DEFAULT_ENABLED;
    return normalizeEnabled(JSON.parse(row.value));
  } catch {
    return DEFAULT_ENABLED;
  }
}

// ── 平台级人设提示词（pa8）：系统级注入，统一角色语气 / 能力边界 / 拒答范围 ──
export const DEFAULT_PERSONA = "";
export const PERSONA_MAX_LEN = 4000;

export function normalizePersona(input: unknown): string {
  const raw = typeof input === "string" ? input : "";
  return raw.trim().slice(0, PERSONA_MAX_LEN);
}

// ── 任务状态文案（pa31）：只影响前台展示，不影响任务真实状态与结算 ──
export interface TaskCopy {
  queued: string;
  running: string;
  failed: string;
  timeout: string;
}

export const DEFAULT_TASK_COPY: TaskCopy = {
  queued: "任务已提交，排队中…",
  running: "生成中",
  failed: "生成失败，预扣积分已全额退回",
  timeout: "任务超时，预扣积分已全额退回",
};

const COPY_MAX_LEN = 60;

function normalizeCopyText(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const text = raw.trim();
  if (!text) return fallback;
  return text.slice(0, COPY_MAX_LEN);
}

export function normalizeTaskCopy(input: unknown): TaskCopy {
  const p = (input ?? {}) as Partial<TaskCopy>;
  return {
    queued: normalizeCopyText(p.queued, DEFAULT_TASK_COPY.queued),
    running: normalizeCopyText(p.running, DEFAULT_TASK_COPY.running),
    failed: normalizeCopyText(p.failed, DEFAULT_TASK_COPY.failed),
    timeout: normalizeCopyText(p.timeout, DEFAULT_TASK_COPY.timeout),
  };
}

// ── 限流提示语（pa30）：会员被日次数 / 每分钟次数限流时返回的可读文案 ──
export const DEFAULT_RATE_LIMIT_NOTICE = "当前排队人数较多，请稍后再试";

export function normalizeRateLimitNotice(input: unknown): string {
  const raw = typeof input === "string" ? input : (input as { text?: unknown } | null)?.text;
  return normalizeCopyText(raw, DEFAULT_RATE_LIMIT_NOTICE);
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function readString(raw: unknown, fallback: string, maxLen: number): string {
  if (typeof raw !== "string") return fallback;
  const v = raw.trim().slice(0, maxLen);
  return v || fallback;
}

export function normalizeGuestTrial(input: unknown): GuestTrialConfig {
  const p = (input ?? {}) as Partial<GuestTrialConfig>;
  return {
    enabled: p.enabled === true,
    maxTrials: clampInt(p.maxTrials, 0, MAX_GUEST_TRIALS, DEFAULT_GUEST_TRIAL.maxTrials),
  };
}

export function normalizeDefaultModels(input: unknown): DefaultModels {
  const p = (input ?? {}) as Partial<DefaultModels>;
  return {
    image: readString(p.image, DEFAULT_MODELS.image, 120),
    video: readString(p.video, DEFAULT_MODELS.video, 120),
  };
}

export function normalizeParamPolicy(input: unknown): ParamPolicy {
  const p = (input ?? {}) as Partial<ParamPolicy>;
  return { lockDefaults: p.lockDefaults === true };
}

/** 返回规范化后的上限，以及是否发生了「超出模型能力被截断」 */
export function normalizeReferenceLimits(input: unknown): {
  limits: ReferenceLimits;
  clampedImages: boolean;
  clampedVideos: boolean;
} {
  const p = (input ?? {}) as Partial<ReferenceLimits>;
  const pick = (raw: unknown, hard: number): { value: number | null; clamped: boolean } => {
    if (raw == null || raw === "") return { value: null, clamped: false };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { value: null, clamped: false };
    const v = Math.trunc(n);
    if (v > hard) return { value: hard, clamped: true };
    return { value: Math.min(hard, Math.max(0, v)), clamped: false };
  };
  const a = pick(p.maxReferenceImages, HARD_MAX_REFERENCE_IMAGES);
  const b = pick(p.maxReferenceVideos, HARD_MAX_REFERENCE_VIDEOS);
  return {
    limits: { maxReferenceImages: a.value, maxReferenceVideos: b.value },
    clampedImages: a.clamped,
    clampedVideos: b.clamped,
  };
}

/** 返回规范化后的上传限制，以及体积是否被硬上限截断 */
export function normalizeUploadLimits(input: unknown): {
  limits: UploadLimits;
  clampedImage: boolean;
  clampedVideo: boolean;
} {
  const p = (input ?? {}) as Partial<UploadLimits>;
  const rawImage = Number(p.imageMaxMB);
  const rawVideo = Number(p.videoMaxMB);
  const imageMaxMB = Number.isFinite(rawImage)
    ? Math.min(HARD_MAX_IMAGE_MB, Math.max(1, Math.trunc(rawImage)))
    : DEFAULT_UPLOAD_LIMITS.imageMaxMB;
  const videoMaxMB = Number.isFinite(rawVideo)
    ? Math.min(HARD_MAX_VIDEO_MB, Math.max(1, Math.trunc(rawVideo)))
    : DEFAULT_UPLOAD_LIMITS.videoMaxMB;
  const pickFormats = (raw: unknown, allowed: readonly string[], fallback: string[]): string[] => {
    if (!Array.isArray(raw)) return [...fallback];
    const set = new Set(raw.map((v) => String(v)));
    return allowed.filter((v) => set.has(v));
  };
  return {
    limits: {
      imageMaxMB,
      videoMaxMB,
      imageFormats: pickFormats(p.imageFormats, IMAGE_FORMAT_OPTIONS, DEFAULT_UPLOAD_LIMITS.imageFormats),
      videoFormats: pickFormats(p.videoFormats, VIDEO_FORMAT_OPTIONS, DEFAULT_UPLOAD_LIMITS.videoFormats),
    },
    clampedImage: Number.isFinite(rawImage) && rawImage > HARD_MAX_IMAGE_MB,
    clampedVideo: Number.isFinite(rawVideo) && rawVideo > HARD_MAX_VIDEO_MB,
  };
}

async function readJson(key: string): Promise<unknown> {
  try {
    const row = await db.siteSetting.findUnique({ where: { key } });
    if (!row) return null;
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  await db.siteSetting.upsert({
    where: { key },
    update: { value: text },
    create: { key, value: text },
  });
}

export async function getPlaygroundSettings(): Promise<PlaygroundSettings> {
  try {
    const rows = await db.siteSetting.findMany({
      where: { key: { in: Object.values(SETTING_KEYS) } },
      select: { key: true, value: true },
    });
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const parse = (key: string): unknown => {
      const raw = map.get(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    };
    return {
      guest: normalizeGuestTrial(parse(SETTING_KEYS.guest)),
      defaultModels: normalizeDefaultModels(parse(SETTING_KEYS.defaults)),
      paramPolicy: normalizeParamPolicy(parse(SETTING_KEYS.lock)),
      limits: normalizeReferenceLimits(parse(SETTING_KEYS.limits)).limits,
      upload: normalizeUploadLimits(parse(SETTING_KEYS.upload)).limits,
      copy: normalizeTaskCopy(parse(SETTING_KEYS.copy)),
      rateLimitNotice: normalizeRateLimitNotice(parse(SETTING_KEYS.notice)),
      persona: normalizePersona(parse(SETTING_KEYS.persona)),
      enabled: normalizeEnabled(parse(SETTING_KEYS.enabled)),
    };
  } catch {
    return {
      guest: { ...DEFAULT_GUEST_TRIAL },
      defaultModels: { ...DEFAULT_MODELS },
      paramPolicy: { ...DEFAULT_PARAM_POLICY },
      limits: { ...DEFAULT_REFERENCE_LIMITS },
      upload: { ...DEFAULT_UPLOAD_LIMITS },
      copy: { ...DEFAULT_TASK_COPY },
      rateLimitNotice: DEFAULT_RATE_LIMIT_NOTICE,
      persona: DEFAULT_PERSONA,
      enabled: DEFAULT_ENABLED,
    };
  }
}

export async function getGuestTrialConfig(): Promise<GuestTrialConfig> {
  return (await getPlaygroundSettings()).guest;
}

export async function setGuestTrialConfig(cfg: GuestTrialConfig): Promise<GuestTrialConfig> {
  const normalized = normalizeGuestTrial(cfg);
  await writeJson(SETTING_KEYS.guest, normalized);
  return normalized;
}

export async function setDefaultModels(cfg: DefaultModels): Promise<DefaultModels> {
  const normalized = normalizeDefaultModels(cfg);
  await writeJson(SETTING_KEYS.defaults, normalized);
  return normalized;
}

export async function setParamPolicy(cfg: ParamPolicy): Promise<ParamPolicy> {
  const normalized = normalizeParamPolicy(cfg);
  await writeJson(SETTING_KEYS.lock, normalized);
  return normalized;
}

export async function setReferenceLimits(cfg: ReferenceLimits): Promise<ReturnType<typeof normalizeReferenceLimits>> {
  const normalized = normalizeReferenceLimits(cfg);
  await writeJson(SETTING_KEYS.limits, normalized.limits);
  return normalized;
}

export async function setUploadLimits(cfg: UploadLimits): Promise<ReturnType<typeof normalizeUploadLimits>> {
  const normalized = normalizeUploadLimits(cfg);
  await writeJson(SETTING_KEYS.upload, normalized.limits);
  return normalized;
}

export async function setTaskCopy(cfg: TaskCopy): Promise<TaskCopy> {
  const normalized = normalizeTaskCopy(cfg);
  await writeJson(SETTING_KEYS.copy, normalized);
  return normalized;
}

export async function setRateLimitNotice(text: unknown): Promise<string> {
  const normalized = normalizeRateLimitNotice(text);
  await writeJson(SETTING_KEYS.notice, normalized);
  return normalized;
}

export async function setPersona(text: unknown): Promise<string> {
  const normalized = normalizePersona(text);
  await writeJson(SETTING_KEYS.persona, normalized);
  return normalized;
}

export async function setPlaygroundEnabled(input: unknown): Promise<boolean> {
  const normalized = normalizeEnabled(input);
  await writeJson(SETTING_KEYS.enabled, normalized);
  return normalized;
}

// ── 游客试玩计数（按 IP，存 SiteSetting 单行 JSON，不动库结构） ──
const GUEST_PREFIX = "playground_guest:";
const GUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface GuestUsage {
  count: number;
  at: string | null;
}

async function readGuestUsage(ip: string): Promise<GuestUsage> {
  try {
    const row = await db.siteSetting.findUnique({ where: { key: GUEST_PREFIX + ip } });
    if (!row) return { count: 0, at: null };
    const p = JSON.parse(row.value) as Partial<GuestUsage>;
    const count = Number.isFinite(p.count) ? Math.max(0, Math.trunc(Number(p.count))) : 0;
    return { count, at: typeof p.at === "string" ? p.at : null };
  } catch {
    return { count: 0, at: null };
  }
}

// 顺带清理 30 天未活跃的游客计数行（每个进程每天最多一次，尽力而为）
const guestCleanup = globalThis as { __pgGuestCleanupAt?: number };
function maybeCleanupGuestRows() {
  const now = Date.now();
  if (guestCleanup.__pgGuestCleanupAt && now - guestCleanup.__pgGuestCleanupAt < 86_400_000) return;
  guestCleanup.__pgGuestCleanupAt = now;
  void db.siteSetting
    .deleteMany({
      where: { key: { startsWith: GUEST_PREFIX }, updatedAt: { lt: new Date(now - GUEST_TTL_MS) } },
    })
    .catch(() => {});
}

export async function getGuestRemaining(ip: string, maxTrials: number): Promise<number> {
  if (maxTrials <= 0) return 0;
  const usage = await readGuestUsage(ip);
  return Math.max(0, maxTrials - usage.count);
}

/**
 * 占用一次游客试玩额度。
 * - 未开启 / 次数为 0 / 已用尽：ok=false，remaining=0
 * - 成功：ok=true，remaining=剩余次数
 * 只在提交生成前调用；游客不计费、不退款，失败也不返还次数（与「试玩次数」口径一致）。
 */
export async function consumeGuestTrial(
  ip: string,
  maxTrials: number
): Promise<{ ok: boolean; remaining: number }> {
  if (maxTrials <= 0) return { ok: false, remaining: 0 };
  const usage = await readGuestUsage(ip);
  if (usage.count >= maxTrials) return { ok: false, remaining: 0 };
  const next: GuestUsage = { count: usage.count + 1, at: new Date().toISOString() };
  try {
    await db.siteSetting.upsert({
      where: { key: GUEST_PREFIX + ip },
      update: { value: JSON.stringify(next) },
      create: { key: GUEST_PREFIX + ip, value: JSON.stringify(next) },
    });
  } catch {
    // 计数写失败时不放行，避免无限试玩
    return { ok: false, remaining: 0 };
  }
  maybeCleanupGuestRows();
  return { ok: true, remaining: Math.max(0, maxTrials - next.count) };
}

// ── 锁定默认参数时的固定值（前后端同源，服务端强制覆盖） ──
export const LOCKED_IMAGE_DEFAULTS = { resolution: "1080", ratio: "16:9", count: 1 } as const;
export const LOCKED_VIDEO_DEFAULTS = { resolution: "720p", ratio: "16:9", duration: 5 } as const;
