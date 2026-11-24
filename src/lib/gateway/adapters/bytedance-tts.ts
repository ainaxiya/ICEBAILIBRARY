// ─── 字节跳动（bytedance / openspeech）TTS 专用适配器 ───
// 上游非 OpenAI 协议，鉴权头、请求体、响应结构都不同，按 protocol=bytedance 分流
// （兼容历史值 openspeech，读取时两者等价）。
//
// 两条上游能力：
//   1) /api/v3/tts/create   同步音频生成（seed-audio-1.0，text_prompt ≤3000 字，输出 ≤120s）
//      响应 JSON 内 audio 为 Base64；另有 duration / original_duration（计费依据）/ url（2 小时）
//   2) /api/v3/tts/submit + /api/v3/tts/query  异步长文本（seed-tts-2.0 / seed-icl-2.0 字符版，
//      单次 ≤10 万字符；音频服务端存 7 天，下载链接 1 小时）
//
// 鉴权：新版控制台 X-Api-Key 单头；X-Api-Request-Id 可选（用于追踪）。

export type BytedanceTtsMode = "create" | "submit";

export interface BytedanceTtsConfig {
  mode: BytedanceTtsMode;
  // create 用：请求体里的 model
  modelName?: string;
  // submit 用：X-Api-Resource-Id（seed-tts-2.0 / seed-icl-2.0）
  resourceId?: string;
}

// 参考资源（三种形态）：speaker / audio_* 互斥；image_* 不能与音频混用
export interface BytedanceTtsReference {
  speaker?: string;
  audio_data?: string;
  audio_url?: string;
  image_data?: string;
  image_url?: string;
}

export interface AudioFormatPick {
  format: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// ─── 模型 → 上游模式 ───
// 默认约定：seed-audio-* → create；seed-tts-* / seed-icl-* → submit（resourceId 取主版本号，如 seed-tts-2.0）。
// 需要覆盖时在 AiModel.advancedConfig 里写：{"bytedance":{"mode":"submit","resourceId":"seed-tts-2.0"}}
// （历史键 openspeech 仍然兼容）
export function resolveBytedanceTtsConfig(
  modelName: string,
  advancedConfig?: string | null
): BytedanceTtsConfig | null {
  const name = (modelName || "").trim();
  if (advancedConfig && advancedConfig.trim()) {
    try {
      const adv = JSON.parse(advancedConfig) as unknown;
      const node = isRecord(adv)
        ? isRecord(adv.bytedance)
          ? adv.bytedance
          : isRecord(adv.openspeech)
            ? adv.openspeech
            : null
        : null;
      if (node) {
        const o = node;
        const mode = str(o.mode);
        if (mode === "create") {
          return { mode: "create", modelName: str(o.modelName) || name || "seed-audio-1.0" };
        }
        if (mode === "submit") {
          const rid = str(o.resourceId);
          if (rid) return { mode: "submit", resourceId: rid };
        }
      }
    } catch {
      // advancedConfig 不是合法 JSON：忽略，走名称约定
    }
  }

  if (/^seed-audio/i.test(name)) {
    return { mode: "create", modelName: name || "seed-audio-1.0" };
  }
  const m = /^(seed-(?:tts|icl)-\d+\.\d+)/i.exec(name);
  if (m) {
    return { mode: "submit", resourceId: m[1].toLowerCase() };
  }
  return null;
}

// ─── 输出格式映射（OpenAI response_format → 上游 audio_config.format） ───
// create 支持 wav/mp3/pcm/ogg_opus；submit 支持 mp3/pcm/ogg_opus
export function mapAudioFormat(
  raw: string | undefined,
  mode: BytedanceTtsMode
): AudioFormatPick | { error: string } {
  const f = (raw || "mp3").trim().toLowerCase();
  const normalized = f === "opus" ? "ogg_opus" : f;
  const allowed = mode === "create" ? ["wav", "mp3", "pcm", "ogg_opus"] : ["mp3", "pcm", "ogg_opus"];
  if (!allowed.includes(normalized)) {
    return {
      error: `response_format "${raw}" is not supported by this model (allowed: ${allowed.join(", ")})`,
    };
  }
  return { format: normalized };
}

// ─── 语速映射：OpenAI speed(0.25–4) → 上游 speech_rate[-50,100] ───
// 0.5x=-50、1x=0、2x=100，线性后截断
export function mapSpeedToSpeechRate(speed: number | undefined): number {
  if (speed == null || !Number.isFinite(speed)) return 0;
  const rate = Math.round((speed - 1) * 100);
  return Math.max(-50, Math.min(100, rate));
}

// ─── 参考资源校验（文档：speaker/audio_data/audio_url 互斥；图片不与音频混用） ───
export function validateReferences(
  voice: string | undefined,
  refs: BytedanceTtsReference[] | undefined
): { ok: true; references: BytedanceTtsReference[] } | { ok: false; error: string } {
  const list = Array.isArray(refs) ? refs.filter(isRecord) : [];
  if (list.length === 0) {
    if (!voice) return { ok: false, error: "voice (speaker id) is required" };
    return { ok: true, references: [{ speaker: voice }] };
  }
  if (voice && list.length > 1) {
    return { ok: false, error: "voice and multiple references cannot be used together" };
  }
  const hasImage = list.some((r) => str(r.image_data) || str(r.image_url));
  const hasAudio = list.some((r) => str(r.speaker) || str(r.audio_data) || str(r.audio_url));
  if (hasImage && hasAudio) {
    return { ok: false, error: "image reference cannot be mixed with audio reference" };
  }
  if (hasImage) {
    if (list.length > 1) return { ok: false, error: "at most 1 image reference is supported" };
    const r = list[0];
    if (str(r.image_data) && str(r.image_url)) {
      return { ok: false, error: "image_data and image_url are mutually exclusive" };
    }
    if (!str(r.image_data) && !str(r.image_url)) {
      return { ok: false, error: "image reference requires image_data or image_url" };
    }
    return { ok: true, references: [{ image_data: str(r.image_data) || undefined, image_url: str(r.image_url) || undefined }] };
  }
  if (list.length > 3) return { ok: false, error: "at most 3 audio references are supported" };

  const out: BytedanceTtsReference[] = [];
  for (const r of list) {
    const forms = [str(r.speaker), str(r.audio_data), str(r.audio_url)].filter(Boolean);
    if (forms.length === 0) {
      return { ok: false, error: "audio reference requires speaker, audio_data or audio_url" };
    }
    if (forms.length > 1) {
      return { ok: false, error: "speaker, audio_data and audio_url are mutually exclusive" };
    }
    out.push({
      speaker: str(r.speaker) || undefined,
      audio_data: str(r.audio_data) || undefined,
      audio_url: str(r.audio_url) || undefined,
    });
  }
  return { ok: true, references: out };
}

// ─── 非法控制字符占比（文档：>10% 直接报错，不含 \t \n） ───
export function illegalControlRatio(text: string): number {
  if (!text) return 0;
  let bad = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 0x20 && ch !== "\t" && ch !== "\n") || code === 0x7f) bad++;
  }
  return bad / Array.from(text).length;
}

// ─── 请求体构造 ───
export interface CreateTtsBodyInput {
  text: string;
  format: string;
  sampleRate?: number;
  speed?: number;
  references: BytedanceTtsReference[];
}

export function buildCreateBody(cfg: BytedanceTtsConfig, input: CreateTtsBodyInput): Record<string, unknown> {
  const audioConfig: Record<string, unknown> = {
    format: input.format,
    pitch_rate: 0,
    speech_rate: mapSpeedToSpeechRate(input.speed),
    loudness_rate: 0,
  };
  if (input.sampleRate) audioConfig.sample_rate = input.sampleRate;
  return {
    model: cfg.modelName || "seed-audio-1.0",
    text_prompt: input.text,
    references: input.references,
    audio_config: audioConfig,
    watermark: {},
  };
}

export interface SubmitTtsBodyInput {
  userId: number | string;
  text: string;
  voice: string;
  format: string;
  sampleRate?: number;
  speed?: number;
}

export function buildSubmitBody(input: SubmitTtsBodyInput): Record<string, unknown> {
  const audioParams: Record<string, unknown> = {
    format: input.format,
    speech_rate: mapSpeedToSpeechRate(input.speed),
    loudness_rate: 0,
  };
  if (input.sampleRate) audioParams.sample_rate = input.sampleRate;
  return {
    user: { uid: String(input.userId) },
    req_params: {
      text: input.text,
      speaker: input.voice,
      audio_params: audioParams,
    },
  };
}

// ─── 错误映射 ───
export interface MappedUpstreamError {
  status: number;
  code: string;
  message: string;
}

export function mapUpstreamError(
  httpStatus: number,
  code?: number | string | null,
  message?: string | null
): MappedUpstreamError {
  const n = typeof code === "number" ? code : Number(code);
  const msg = (message || "").trim() || `Upstream HTTP ${httpStatus}`;
  // 并发超限：文档 45000000 + "quota exceeded for types: concurrency"
  if (n === 45000000 && /concurr/i.test(msg)) {
    return { status: 429, code: "upstream_concurrency", message: `Upstream concurrency limit: ${msg}` };
  }
  if (Number.isFinite(n) && n >= 45000000 && n < 46000000) {
    return { status: 400, code: "upstream_invalid_request", message: msg };
  }
  if (Number.isFinite(n) && n >= 55000000 && n < 56000000) {
    return { status: 502, code: "upstream_error", message: msg };
  }
  if (httpStatus === 429) return { status: 429, code: "upstream_rate_limited", message: msg };
  if (httpStatus >= 400 && httpStatus < 500) {
    return { status: 400, code: "upstream_invalid_request", message: msg };
  }
  return { status: 502, code: "upstream_error", message: msg };
}

// ─── HTTP 调用 ───
const DEFAULT_CREATE_TIMEOUT_MS = 330_000;
const DEFAULT_POLL_MIN_MS = 1_000;
const DEFAULT_POLL_MAX_MS = 3_000;
const DEFAULT_ASYNC_WAIT_MS = 900_000;

function envInt(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name];
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return fallback;
}

function joinBase(apiBase: string): string {
  return apiBase.replace(/\/+$/, "");
}

function headers(apiKey: string, requestId?: string, resourceId?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": apiKey,
  };
  if (requestId) h["X-Api-Request-Id"] = requestId;
  if (resourceId) h["X-Api-Resource-Id"] = resourceId;
  return h;
}

async function postJson(opts: {
  url: string;
  apiKey: string;
  requestId?: string;
  resourceId?: string;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const res = await fetch(opts.url, {
    method: "POST",
    headers: headers(opts.apiKey, opts.requestId, opts.resourceId),
    body: JSON.stringify(opts.body),
    signal,
  });
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) json = parsed;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function errFrom(
  status: number,
  json: Record<string, unknown> | null,
  text: string
): MappedUpstreamError {
  const code = json ? (json.code as number | string | undefined) : undefined;
  const message = json ? str(json.message) : "";
  return mapUpstreamError(status, code ?? null, message || text.slice(0, 200));
}

// create：同步音频生成
export interface CreateResult {
  ok: boolean;
  status: number;
  audioBase64?: string;
  durationSec?: number | null;
  originalDurationSec?: number | null;
  url?: string | null;
  error?: MappedUpstreamError;
}

export async function callBytedanceTtsCreate(opts: {
  apiBase: string;
  apiKey: string;
  requestId?: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<CreateResult> {
  let r: Awaited<ReturnType<typeof postJson>>;
  try {
    r = await postJson({
      url: `${joinBase(opts.apiBase)}/api/v3/tts/create`,
      apiKey: opts.apiKey,
      requestId: opts.requestId,
      body: opts.body,
      timeoutMs: envInt(["BYTEDANCE_TTS_CREATE_TIMEOUT_MS", "OPENSPEECH_CREATE_TIMEOUT_MS"], DEFAULT_CREATE_TIMEOUT_MS),
      signal: opts.signal,
    });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "上游响应超时" : (e as Error).message;
    return { ok: false, status: 0, error: { status: 502, code: "upstream_timeout", message: msg } };
  }

  if (r.status < 200 || r.status >= 300) {
    return { ok: false, status: r.status, error: errFrom(r.status, r.json, r.text) };
  }
  const json = r.json;
  if (!json) {
    return { ok: false, status: r.status, error: { status: 502, code: "upstream_error", message: "上游返回非 JSON" } };
  }
  // 成功样例不带 code；带 code 且非 0 视为失败
  const code = num(json.code);
  if (code != null && code !== 0) {
    return { ok: false, status: r.status, error: errFrom(r.status, json, r.text) };
  }
  const audio = str(json.audio) || str(json.data);
  if (!audio) {
    return {
      ok: false,
      status: r.status,
      error: { status: 502, code: "upstream_error", message: str(json.message) || "上游未返回音频数据" },
    };
  }
  return {
    ok: true,
    status: r.status,
    audioBase64: audio,
    durationSec: num(json.duration),
    originalDurationSec: num(json.original_duration),
    url: str(json.url) || null,
  };
}

// submit：提交异步任务
export interface SubmitResult {
  ok: boolean;
  status: number;
  taskId?: string;
  reqTextLength?: number | null;
  error?: MappedUpstreamError;
}

export async function callBytedanceTtsSubmit(opts: {
  apiBase: string;
  apiKey: string;
  resourceId: string;
  requestId?: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<SubmitResult> {
  let r: Awaited<ReturnType<typeof postJson>>;
  try {
    r = await postJson({
      url: `${joinBase(opts.apiBase)}/api/v3/tts/submit`,
      apiKey: opts.apiKey,
      resourceId: opts.resourceId,
      requestId: opts.requestId,
      body: opts.body,
      timeoutMs: 60_000,
      signal: opts.signal,
    });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "上游响应超时" : (e as Error).message;
    return { ok: false, status: 0, error: { status: 502, code: "upstream_timeout", message: msg } };
  }

  if (r.status < 200 || r.status >= 300) {
    return { ok: false, status: r.status, error: errFrom(r.status, r.json, r.text) };
  }
  const json = r.json;
  const code = json ? num(json.code) : null;
  if (!json || code !== 20000000) {
    return {
      ok: false,
      status: r.status,
      error: json
        ? errFrom(r.status, json, r.text)
        : { status: 502, code: "upstream_error", message: "上游返回非 JSON" },
    };
  }
  const data = isRecord(json.data) ? json.data : {};
  const taskId = str(data.task_id);
  if (!taskId) {
    return { ok: false, status: r.status, error: { status: 502, code: "upstream_error", message: "上游未返回 task_id" } };
  }
  return { ok: true, status: r.status, taskId, reqTextLength: num(data.req_text_length) };
}

// query：查询任务
export interface QueryResult {
  ok: boolean;
  status: number;
  // 1 运行 / 2 成功 / 3 失败
  taskStatus?: 1 | 2 | 3;
  audioUrl?: string | null;
  urlExpireTime?: number | null;
  reqTextLength?: number | null;
  synthesizeTextLength?: number | null;
  error?: MappedUpstreamError;
}

export async function callBytedanceTtsQuery(opts: {
  apiBase: string;
  apiKey: string;
  resourceId: string;
  requestId?: string;
  taskId: string;
  signal?: AbortSignal;
}): Promise<QueryResult> {
  let r: Awaited<ReturnType<typeof postJson>>;
  try {
    r = await postJson({
      url: `${joinBase(opts.apiBase)}/api/v3/tts/query`,
      apiKey: opts.apiKey,
      resourceId: opts.resourceId,
      requestId: opts.requestId,
      body: { task_id: opts.taskId },
      timeoutMs: 30_000,
      signal: opts.signal,
    });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "上游响应超时" : (e as Error).message;
    return { ok: false, status: 0, error: { status: 502, code: "upstream_timeout", message: msg } };
  }

  if (r.status < 200 || r.status >= 300) {
    return { ok: false, status: r.status, error: errFrom(r.status, r.json, r.text) };
  }
  const json = r.json;
  const code = json ? num(json.code) : null;
  if (!json || code !== 20000000) {
    return {
      ok: false,
      status: r.status,
      error: json
        ? errFrom(r.status, json, r.text)
        : { status: 502, code: "upstream_error", message: "上游返回非 JSON" },
    };
  }
  const data = isRecord(json.data) ? json.data : {};
  const ts = num(data.task_status);
  const taskStatus: 1 | 2 | 3 = ts === 2 ? 2 : ts === 3 ? 3 : 1;
  return {
    ok: true,
    status: r.status,
    taskStatus,
    audioUrl: str(data.audio_url) || null,
    urlExpireTime: num(data.url_expire_time),
    reqTextLength: num(data.req_text_length),
    synthesizeTextLength: num(data.synthesize_text_length),
  };
}

// submit + query 轮询到终态（2 成功 / 3 失败）；超时按失败处理
export interface WaitResult {
  ok: boolean;
  audioUrl?: string;
  reqTextLength?: number | null;
  error?: MappedUpstreamError;
}

export async function waitBytedanceTtsTask(opts: {
  apiBase: string;
  apiKey: string;
  resourceId: string;
  taskId: string;
  requestId?: string;
  signal?: AbortSignal;
}): Promise<WaitResult> {
  const deadline = Date.now() + envInt(["BYTEDANCE_TTS_ASYNC_WAIT_MS", "OPENSPEECH_ASYNC_WAIT_MS"], DEFAULT_ASYNC_WAIT_MS);
  const min = envInt(["BYTEDANCE_TTS_POLL_MIN_MS", "OPENSPEECH_POLL_MIN_MS"], DEFAULT_POLL_MIN_MS);
  const max = Math.max(min, envInt(["BYTEDANCE_TTS_POLL_MAX_MS", "OPENSPEECH_POLL_MAX_MS"], DEFAULT_POLL_MAX_MS));
  let delay = min;
  let lastErr: MappedUpstreamError | undefined;

  while (Date.now() < deadline) {
    const q = await callBytedanceTtsQuery(opts);
    if (q.ok) {
      if (q.taskStatus === 2) {
        if (!q.audioUrl) {
          return {
            ok: false,
            error: { status: 502, code: "upstream_error", message: "任务成功但未返回下载地址" },
          };
        }
        return { ok: true, audioUrl: q.audioUrl, reqTextLength: q.reqTextLength };
      }
      if (q.taskStatus === 3) {
        return { ok: false, error: { status: 502, code: "upstream_task_failed", message: "上游合成任务失败" } };
      }
      lastErr = undefined;
    } else {
      // 暂时性错误（超时/5xx）继续轮询，其它错误直接失败
      lastErr = q.error;
      if (q.error && q.error.status < 500) {
        return { ok: false, error: q.error };
      }
    }

    const left = deadline - Date.now();
    if (left <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, left)));
    delay = Math.min(max, Math.round(delay * 1.5));
  }

  return {
    ok: false,
    error: lastErr ?? {
      status: 504,
      code: "upstream_timeout",
      message: "等待上游合成任务超时，已按失败退款",
    },
  };
}

// 供路由做单位换算前判空
export function isCreateMode(cfg: BytedanceTtsConfig): boolean {
  return cfg.mode === "create";
}
