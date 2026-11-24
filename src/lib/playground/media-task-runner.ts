import type { ModelPricing, PlaygroundMediaTask, Prisma } from "@prisma/client";
import { unlinkSync } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { billing } from "@/lib/gateway/billing";
import { callMediaGenerations } from "@/lib/gateway/adapters/media";
import { callArkVideoTask } from "@/lib/gateway/adapters/ark-video";
import {
  videoPricingForVariant,
  videoVariantFromBody,
  costMilli,
  displayMemberCredits,
  pricingSnapshot,
} from "@/lib/gateway/pricing";
import { markKeyUsed, recordKeyOutcome, releaseKeyProbe, resolveRoute, tryAcquireKeyCall, type KeyCandidate } from "@/lib/gateway/router";
import { recordUsage } from "@/lib/gateway/usage";
import { storePlaygroundAsset, storePlaygroundBytes } from "./media-store";
import { assertImageMinSide, firstFrameDataUrl } from "./first-frame";
import { videoCapabilityFor } from "./video-capability";
import { assertReferenceVideoDuration, attachmentUpstreamUrl } from "./attachments";

// ─── 冰山实验场 M4：统一媒体任务后台执行器 ───
// 图片：上游是同步接口，但放到后台跑——HTTP 请求只负责创建任务，worker 的执行时间
//       不受前端 60s 限制；上游自身仍有超时，我们的上限见 IMAGE_WORKER_TIMEOUT_MS。
// 视频：上游是任务式（提交 → 轮询 → 取产物），按官方三段式实现。
// 两者共用同一张表与同一套状态机：queued → running → succeeded / failed。
// 失败一律全额退回预扣积分；任务状态落库，进程重启后 GET 接口仍能查到终态。

// 本进程身份：worker 抢占任务时写进 params.bootId。重启恢复据此区分
// 「本进程在跑的任务」（不动）与「死进程遗留的任务」（收口/续跑）。
const PROCESS_BOOT_ID = globalThis.crypto.randomUUID().slice(0, 8);

// ── 队列租约（P6 #21 常驻 Worker）──
// 与视频网关同一口径：60 秒续租、3 分钟到期；进程崩溃后租约过期即可被接管。
// attempts 上限 3，防止死循环重跑。
export const MEDIA_LEASE_MS = 3 * 60_000;
export const MEDIA_LEASE_RENEW_MS = 60_000;
export const MEDIA_MAX_ATTEMPTS = 3;
export const MEDIA_WORKER_ID = `media-${process.env.HOSTNAME || "local"}-${process.pid}`;

// 原子抢占：queued，或「租约已过期」的 running（崩溃遗留）都可接管。
// 注意：running + 视频已有 upstreamJobId 的恢复不走这里（recoverStaleTasks 走 resume），
// 否则会重复提交上游、重复扣费。
export async function claimMediaTask(taskId: string): Promise<boolean> {
  const now = new Date();
  const claimed = await db.playgroundMediaTask.updateMany({
    where: {
      taskId,
      attempts: { lt: MEDIA_MAX_ATTEMPTS },
      OR: [
        { status: "queued" },
        { status: "running", lockedUntil: { lt: now } },
        { status: "running", lockedUntil: null, updatedAt: { lt: new Date(now.getTime() - MEDIA_LEASE_MS) } },
      ],
    },
    data: {
      status: "running",
      stage: "提交上游",
      progress: 5,
      attempts: { increment: 1 },
      lockedUntil: new Date(now.getTime() + MEDIA_LEASE_MS),
      workerId: MEDIA_WORKER_ID,
    },
  });
  return claimed.count > 0;
}

// 续租：图片/视频都可能跑十几分钟，执行期间持续延长租约
function startMediaLeaseRenewal(taskId: string): () => void {
  const timer = setInterval(() => {
    void db.playgroundMediaTask
      .updateMany({
        where: { taskId, status: "running", workerId: MEDIA_WORKER_ID },
        data: { lockedUntil: new Date(Date.now() + MEDIA_LEASE_MS) },
      })
      .catch(() => {});
  }, MEDIA_LEASE_RENEW_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function baseOf(apiBase: string): string {
  return apiBase.replace(/\/+$/, "");
}

function authHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}` };
}

// 图片 worker 执行上限：必须 ≥ 共享 SUBMIT_TIMEOUT_MS（现为 10 分钟），否则内层先断、
// 外层上限形同虚设。这里取 12 分钟，给「上游返回 → 下载产物 → 落盘」留出余量。
// 超时按失败处理并全额退分（前端不再等这条 HTTP 请求）。
export const IMAGE_WORKER_TIMEOUT_MS = 12 * 60_000;

// 视频：官方示例每 5s 轮询一次；单次查询 15s 超时（网络抖动不判失败，下一轮继续）
const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_POLL_TIMEOUT_MS = 15_000;
const VIDEO_SUBMIT_TIMEOUT_MS = 60_000;
const VIDEO_CONTENT_TIMEOUT_MS = 180_000;
// 视频总等待上限：20 分钟（含排队；30s 1080 实测 3–6 分钟）。超时置失败并全额退分。
// 注意：超时只是我们不再等，上游任务可能仍会跑完，这部分成本由平台承担，不转嫁用户。
const VIDEO_TOTAL_WAIT_MS = 20 * 60_000;

// 主站汇率 / 加价兜底（定价行缺省时用；正常以模型定价行的 fxRateE8 / multiplierBps 为准）
const FALLBACK_FX = 6.68;
const FALLBACK_MULTIPLIER_BPS = 15_000;

// 终态任务保留期：产物在磁盘/桶里另有生命周期，这里只清任务记录
const TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type MediaKind = "image" | "video";

export interface MediaTaskView {
  taskId: string;
  kind: string;
  model: string;
  status: string;
  progress: number;
  stage: string | null;
  size: string | null;
  prompt: string;
  urls: string[];
  error: string | null;
  latencyMs: number | null;
  charged: number;
  createdAt: string;
  finishedAt: string | null;
}

// params JSON 的最小结构（仅本文件读写）
interface StoredParams {
  prompt: string;
  count?: number;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  size?: string;
  // 图生视频首帧：本站上传路径（/uploads/...），worker 读取后以 data URL 传给上游
  imageUrl?: string;
  // 多模态素材（Ark 口径）：尾帧 / 参考图 / 参考视频，均为本站 /uploads/ 路径
  lastFrameUrl?: string;
  referenceImages?: string[];
  referenceVideos?: string[];
  // Ark 生成参数：首尾帧任务 ratio=adaptive；generateAudio 控制有声/无声
  ratio?: string;
  generateAudio?: boolean;
  // 视频任务提交成功后记录的上游任务号：进程重启后据此恢复轮询，不用重新提交
  upstreamJobId?: string;
  // 执行该任务的进程身份：重启恢复据此跳过本进程在跑的任务
  bootId?: string;
}

export function parseParams(raw: string): StoredParams {
  try {
    return JSON.parse(raw) as StoredParams;
  } catch {
    return { prompt: "" };
  }
}

export function toTaskView(t: PlaygroundMediaTask): MediaTaskView {
  let urls: string[] = [];
  if (t.resultUrls) {
    try {
      const parsed = JSON.parse(t.resultUrls) as unknown;
      if (Array.isArray(parsed)) urls = parsed.filter((u): u is string => typeof u === "string");
    } catch {
      urls = [];
    }
  }
  return {
    taskId: t.taskId,
    kind: t.kind,
    model: t.modelSnapshot,
    status: t.status,
    progress: t.progress,
    stage: t.stage,
    size: t.requestSize,
    prompt: parseParams(t.params).prompt,
    urls,
    error: t.errorMessage,
    latencyMs: t.latencyMs,
    charged: Number(t.paidCredits),
    createdAt: t.createdAt.toISOString(),
    finishedAt: t.finishedAt ? t.finishedAt.toISOString() : null,
  };
}

// ── 视频报价（创建任务时同步调用；取不到就拒绝下单，不退回旧价格） ──
// imageUrl：图生视频首帧（本站上传路径）。报价请求同步带上首帧，避免「报价按文生视频、
// 执行按图生视频」的口径偏差；上游不接受该字段时退回不带首帧的报价（仅非图生视频模型可成功）。
export async function fetchVideoQuote(opts: {
  apiBase: string;
  apiKey: string;
  model: string;
  seconds: number;
  size?: string;
  imageUrl?: string | null;
}): Promise<{ ok: boolean; usd?: number; quoteId?: string; status: number; errorMessage?: string }> {
  const base = baseOf(opts.apiBase);

  const request = async (withImage: boolean) => {
    const body: Record<string, unknown> = { model: opts.model, seconds: String(opts.seconds) };
    if (opts.size) body.size = opts.size;
    if (withImage && opts.imageUrl) body.image_url = await firstFrameDataUrl(opts.imageUrl);
    let res: Response;
    try {
      res = await fetch(`${base}/videos/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(opts.apiKey) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(VIDEO_SUBMIT_TIMEOUT_MS),
      });
    } catch (e) {
      const msg = (e as Error).name === "TimeoutError" ? "上游报价超时" : (e as Error).message;
      return { ok: false as const, status: 0, errorMessage: msg };
    }
    const json = (await res.json().catch(() => null)) as {
      quote?: unknown;
      quote_id?: unknown;
      error?: { message?: unknown; code?: unknown };
    } | null;
    if (!res.ok || !json) {
      const detail = typeof json?.error?.message === "string" ? json.error.message : "";
      return {
        ok: false as const,
        status: res.status,
        errorMessage: `HTTP ${res.status}${detail ? `：${detail}` : ""}`,
      };
    }
    const usd = Number(json.quote);
    const quoteId = typeof json.quote_id === "string" ? json.quote_id : "";
    if (!Number.isFinite(usd) || usd <= 0 || !quoteId) {
      return { ok: false as const, status: res.status, errorMessage: "上游报价响应缺少 quote / quote_id" };
    }
    return { ok: true as const, status: res.status, usd, quoteId };
  };

  if (!opts.imageUrl) return request(false);

  let withImage: Awaited<ReturnType<typeof request>>;
  try {
    withImage = await request(true);
  } catch (e) {
    // 本地首帧读取失败（文件被清理等）：如实报错，不静默降级
    return { ok: false, status: 0, errorMessage: `首帧图读取失败：${(e as Error).message}` };
  }
  if (withImage.ok) return withImage;
  // 上游不接受带首帧的报价：退回不带首帧再试一次（图生视频会在这一步继续报「缺少首帧」，
  // 最终仍按失败返回第一段的错误信息，不会静默降级）
  const without = await request(false).catch(() => null);
  return without && without.ok ? without : withImage;
}

// 上游报价（USD）→ 会员预扣积分：USD × 汇率 × 100 积分/元 × 加价系数，向上取整
export function creditsFromQuoteUsd(usd: number, pricing: ModelPricing | null): number {
  const fx = pricing ? Number(pricing.fxRateE8) / 1e8 : FALLBACK_FX;
  const multBps = pricing ? Number(pricing.multiplierBps) : FALLBACK_MULTIPLIER_BPS;
  return Math.max(1, Math.ceil(usd * fx * 100 * (multBps / 10000)));
}

// 上游报价（USD）→ 内部成本（毫积分）：USD × 汇率 × 100 × 1000
export function costMilliFromQuoteUsd(usd: number, pricing: ModelPricing | null): number {
  const fx = pricing ? Number(pricing.fxRateE8) / 1e8 : FALLBACK_FX;
  return Math.round(usd * fx * 100 * 1000);
}

async function patchTask(taskId: string, data: Prisma.PlaygroundMediaTaskUpdateInput) {
  await db.playgroundMediaTask.update({ where: { taskId }, data });
}

// 媒体任务的会话消息：任务结束后同步助手消息文案，刷新/重新登录后读到的不是「正在生成」
async function syncTaskMessage(taskId: string, content: string) {
  await db.playgroundMessage
    .updateMany({ where: { taskId }, data: { content } })
    .catch((e) => console.error("[playground-task] 同步会话消息失败", taskId, e));
}

// 严格匹配本地落盘命名，避免误删其它静态资源（头像、采集图、站点素材等）
const LOCAL_MEDIA_RE = /^\/uploads\/\d{4}-\d{2}\/(?:image|video)-\d+-[A-Za-z0-9]{12}\.[a-z0-9]{2,5}$/;

// 删除任务产物里属于本地落盘的文件；桶外链（http 开头）与其它路径一律跳过
export function removeLocalMediaFiles(resultUrls: string | null) {
  if (!resultUrls) return;
  let urls: unknown;
  try {
    urls = JSON.parse(resultUrls);
  } catch {
    return;
  }
  if (!Array.isArray(urls)) return;
  for (const u of urls) {
    if (typeof u !== "string" || !LOCAL_MEDIA_RE.test(u)) continue;
    try {
      unlinkSync(path.join(process.cwd(), "public", u.slice(1)));
    } catch {
      // 文件已不存在或无权限：清理是尽力而为，不阻断任务清理
    }
  }
}

// 清理过期终态任务（7 天；fire-and-forget，失败不影响主流程）
// 先删本地产物文件再删行，避免「只删行不删文件」导致磁盘只增不减
async function cleanupOldTasks() {
  const before = new Date(Date.now() - TASK_RETENTION_MS);
  const where = { status: { in: ["succeeded", "failed"] }, finishedAt: { lt: before } };
  try {
    const rows = await db.playgroundMediaTask.findMany({
      where,
      select: { resultUrls: true },
    });
    for (const row of rows) removeLocalMediaFiles(row.resultUrls);
    await db.playgroundMediaTask.deleteMany({ where });
  } catch {
    // 清理失败不影响主流程
  }
}

// 游客任务统一用 userId=0 落任务表（不建会员外键关系），全程不计费、不写积分流水
function isGuestTask(task: { userId: number }): boolean {
  return task.userId === 0;
}

// 失败收口：全额退分 + 写失败日志 + 更新任务
async function failTask(task: PlaygroundMediaTask, message: string) {
  // 从未真正开跑的排队任务 startedAt 为空，用时口径退回 createdAt，避免收口时抛空指针
  const latency = Date.now() - (task.startedAt ?? task.createdAt).getTime();
  if (!isGuestTask(task)) {
    try {
      await billing.refund(task.userId, task.requestId);
    } catch (e) {
      console.error(`[playground-task] 退款失败 taskId=${task.taskId}`, e);
    }
    await recordUsage({
      requestId: task.requestId,
      userId: task.userId,
      channel: "onsite",
      apiKeyId: null,
      modelId: task.modelId,
      vendorKeyId: task.vendorKeyId,
      endpointType: task.kind,
      modelSnapshot: task.modelSnapshot,
      promptTokens: 0,
      outputTokens: 0,
      costMilli: 0,
      paidCredits: 0,
      latencyMs: latency,
      status: "failed",
    }).catch(() => {});
  }
  await patchTask(task.taskId, {
    status: "failed",
    stage: "已失败",
    errorMessage: message,
    latencyMs: latency,
    finishedAt: new Date(),
  }).catch(() => {});
  await syncTaskMessage(task.taskId, message);
}

// 图片计费单位：per_image=张数、per_request=1（与主站同口径）
function unitsFor(pricing: ModelPricing, count: number): number {
  if (pricing.unit === "request") return 1;
  return Math.max(1, count);
}

// ── 图片：后台调用同步上游 ──
async function runImage(task: PlaygroundMediaTask) {
  const route = await resolveRoute(task.modelSnapshot);
  if (!route || !route.pricing) throw new Error("模型或定价已失效，已退回预扣积分");
  const pricing = route.pricing;
  const params = parseParams(task.params);
  const body: Record<string, unknown> = {
    model: task.modelSnapshot,
    prompt: params.prompt,
    n: Math.max(1, params.count ?? 1),
  };
  if (task.requestSize) body.size = task.requestSize;

  const attempts: KeyCandidate[] = route.candidates.slice(0, 3);
  if (attempts.length === 0) throw new Error("该模型暂无可用上游渠道");

  let urls: string[] | null = null;
  let used: KeyCandidate | null = null;
  let lastError = "";
  for (const cand of attempts) {
    // U2：真正调用前才占用半开探测名额；名额已被占用则跳过该 Key
    if (!tryAcquireKeyCall(cand.vendorKeyId)) continue;
    markKeyUsed(cand.vendorKeyId);
    await patchTask(task.taskId, { stage: "生成中", progress: 20, vendorKeyId: cand.vendorKeyId });
    let r: Awaited<ReturnType<typeof callMediaGenerations>>;
    try {
      r = await callMediaGenerations({
        endpointType: "image",
        apiBase: cand.apiBase,
        apiKey: cand.apiKey,
        body,
        // worker 上限 5 分钟：超时返回失败，调用方照常退分
        timeoutMs: IMAGE_WORKER_TIMEOUT_MS,
      });
    } catch (e) {
      releaseKeyProbe(cand.vendorKeyId); // 异常退出也要归还探测名额
      throw e;
    }
    const okOut = r.ok && r.urls.length > 0;
    recordKeyOutcome(cand.vendorKeyId, okOut, okOut ? 200 : r.status || 502);
    if (okOut) {
      urls = r.urls;
      used = cand;
      break;
    }
    lastError = r.errorMessage || `HTTP ${r.status}`;
  }
  if (!urls || !used) throw new Error(`上游生成失败：${lastError}`);

  await patchTask(task.taskId, { stage: "下载产物", progress: 80 });
  const assets = [];
  for (let i = 0; i < urls.length; i++) {
    assets.push(
      await storePlaygroundAsset({
        userId: task.userId,
        requestId: task.requestId,
        index: i,
        assetType: "image",
        usageRecordId: null,
        sourceUrl: urls[i],
        guest: isGuestTask(task),
      })
    );
  }

  const guestTask = isGuestTask(task);
  const units = unitsFor(pricing, urls.length);
  const costM = guestTask ? 0 : costMilli(units, pricing, "input");
  const paid = guestTask ? 0 : displayMemberCredits(pricing, units, 0);
  await patchTask(task.taskId, { stage: "结算中", progress: 95 });
  if (!guestTask) {
    await billing.settle(task.userId, task.requestId, paid);
    await recordUsage({
      requestId: task.requestId,
      userId: task.userId,
      channel: "onsite",
      apiKeyId: null,
      modelId: task.modelId,
      vendorKeyId: used.vendorKeyId,
      endpointType: "image",
      modelSnapshot: task.modelSnapshot,
      promptTokens: 0,
      outputTokens: 0,
      unitCount: units,
      costMilli: costM,
      paidCredits: paid,
      latencyMs: Date.now() - task.startedAt!.getTime(),
      status: "success",
      ...pricingSnapshot(pricing),
    });
  }

  await patchTask(task.taskId, {
    status: "succeeded",
    stage: "已完成",
    progress: 100,
    vendorKeyId: used.vendorKeyId,
    resultUrls: JSON.stringify(assets.map((a) => a.url)),
    paidCredits: BigInt(paid),
    costMilli: BigInt(costM),
    latencyMs: Date.now() - task.startedAt!.getTime(),
    finishedAt: new Date(),
    errorMessage: null,
  });
  const elapsed = ((Date.now() - task.startedAt!.getTime()) / 1000).toFixed(1);
  await syncTaskMessage(
    task.taskId,
    `已完成${task.requestSize ? ` · ${task.requestSize}` : ""} · ${elapsed}s`
  );
}

// GET /v1/videos/{id} 响应里我们关心的字段（其余忽略）
interface VideoJobStatus {
  status?: unknown;
  progress?: unknown;
  error?: { code?: unknown; message?: unknown };
}

// ── 视频：上游三段式（提交 → 轮询 → 取产物） ──
async function runVideo(task: PlaygroundMediaTask) {
  const route = await resolveRoute(task.modelSnapshot);
  if (!route) throw new Error("模型已下线或不可用");
  const params = parseParams(task.params);
  const seconds = Math.max(1, params.duration ?? 5);
  const attempts: KeyCandidate[] = route.candidates.slice(0, 3);
  if (attempts.length === 0) throw new Error("该模型暂无可用上游渠道");

  // 火山方舟：走 contents/generations/tasks（提交后内部轮询到终态），
  // 与下方 OpenAI 兼容 /videos 三段式不同，单独一条执行路径，互不影响。
  if (route.vendor.protocol === "ark") {
    await runArkVideo(task, route, params, seconds, attempts);
    return;
  }

  // 1) 提交任务（失败换 Key，最多 3 个）
  const submitBody: Record<string, unknown> = {
    model: task.modelSnapshot,
    prompt: params.prompt,
    seconds: String(seconds),
  };
  if (task.requestSize) submitBody.size = task.requestSize;
  if (params.imageUrl) {
    // 首帧原图直接传（不裁剪）；转 data URL 给上游，本地/线上行为一致
    try {
      submitBody.image_url = await firstFrameDataUrl(params.imageUrl);
    } catch (e) {
      throw new Error(`首帧图读取失败：${(e as Error).message}`);
    }
  } else if (videoCapabilityFor(task.modelSnapshot, route.model.advancedConfig).firstFrame) {
    // 图生视频缺首帧：明确失败并退分，绝不静默降级成文生视频
    throw new Error("图生视频模型缺少首帧图，任务已取消");
  }

  let jobId = "";
  let used: KeyCandidate | null = null;
  let lastError = "";
  for (const cand of attempts) {
    // U2：真正调用前才占用半开探测名额；名额已被占用则跳过该 Key
    if (!tryAcquireKeyCall(cand.vendorKeyId)) continue;
    markKeyUsed(cand.vendorKeyId);
    await patchTask(task.taskId, { stage: "提交上游", progress: 10, vendorKeyId: cand.vendorKeyId });
    let res: Response | null = null;
    try {
      res = await fetch(`${baseOf(cand.apiBase)}/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(cand.apiKey) },
        body: JSON.stringify(submitBody),
        signal: AbortSignal.timeout(VIDEO_SUBMIT_TIMEOUT_MS),
      });
    } catch (e) {
      releaseKeyProbe(cand.vendorKeyId); // 异常退出也要归还探测名额
      lastError = (e as Error).name === "TimeoutError" ? "提交上游超时" : (e as Error).message;
      recordKeyOutcome(cand.vendorKeyId, false, 0);
      continue;
    }
    const json = (await res.json().catch(() => null)) as {
      id?: unknown;
      error?: { message?: unknown };
    } | null;
    const id = typeof json?.id === "string" ? json.id : "";
    const okSubmit = res.ok && !!id;
    recordKeyOutcome(cand.vendorKeyId, okSubmit, res.status);
    if (okSubmit) {
      jobId = id;
      used = cand;
      break;
    }
    const detail = typeof json?.error?.message === "string" ? `：${json.error.message}` : "";
    lastError = `HTTP ${res.status}${detail}`;
  }
  if (!jobId || !used) throw new Error(`上游创建任务失败：${lastError}`);
  const key: KeyCandidate = used;

  // 记录上游任务号：进程重启后 recoverStaleTasks 据此恢复轮询（不重复提交、不重复扣费）
  await patchTask(task.taskId, {
    params: JSON.stringify({ ...params, upstreamJobId: jobId }),
  }).catch(() => {});

  // 档位价优先（分辨率 + 是否含参考视频），档位留空回退统一秒价
  const pricing = videoPricingForVariant(
    route,
    videoVariantFromBody({ resolution: params.resolution ?? "720p", reference_videos: params.referenceVideos ?? [] })
  );
  await pollAndDeliverVideo(task, jobId, key, seconds, pricing);
}

// ── 火山方舟视频：content[] 有序素材 + 顶层参数，提交后内部轮询到终态 ──
// 与 OpenAI 兼容链路的差异：Ark 只在成功响应里给 content.video_url（24h 有效），
// 没有独立下载接口，所以拿到地址后立刻下载转存；计费按本地按秒档位价预扣即结算。
async function runArkVideo(
  task: PlaygroundMediaTask,
  route: NonNullable<Awaited<ReturnType<typeof resolveRoute>>>,
  params: StoredParams,
  seconds: number,
  attempts: KeyCandidate[]
) {
  const ratio = params.ratio ?? params.aspectRatio ?? "16:9";
  const resolution = params.resolution ?? "720p";
  const body: Record<string, unknown> = {
    model: task.modelSnapshot,
    prompt: params.prompt,
    duration: seconds,
    ratio,
    resolution,
    generate_audio: params.generateAudio === true,
  };
  try {
    // worker 兜底校验（排队期间素材可能被替换）：图片宽高 ≥300px、参考视频 ≤30s
    for (const p of [params.imageUrl, params.lastFrameUrl, ...(params.referenceImages ?? [])]) {
      if (p) await assertImageMinSide(p);
    }
    for (const p of params.referenceVideos ?? []) await assertReferenceVideoDuration(p);

    if (params.imageUrl) body.image_url = await attachmentUpstreamUrl(params.imageUrl);
    if (params.lastFrameUrl) body.last_frame = await attachmentUpstreamUrl(params.lastFrameUrl);
    if (params.referenceImages?.length) {
      body.reference_images = await Promise.all(params.referenceImages.map(attachmentUpstreamUrl));
    }
    if (params.referenceVideos?.length) {
      body.reference_videos = await Promise.all(params.referenceVideos.map(attachmentUpstreamUrl));
    }
  } catch (e) {
    throw new Error(`素材读取失败：${(e as Error).message}`);
  }

  // 档位价优先（分辨率 + 是否含参考视频），档位留空回退统一秒价；成本核算同价
  const pricing = videoPricingForVariant(
    route,
    videoVariantFromBody({ resolution: params.resolution ?? "720p", reference_videos: params.referenceVideos ?? [] })
  );

  let lastError = "";
  let used: KeyCandidate | null = null;
  let videoUrl = "";
  for (const cand of attempts) {
    if (!tryAcquireKeyCall(cand.vendorKeyId)) continue;
    markKeyUsed(cand.vendorKeyId);
    await patchTask(task.taskId, { stage: "提交上游", progress: 12, vendorKeyId: cand.vendorKeyId });
    const res = await callArkVideoTask({ apiBase: cand.apiBase, apiKey: cand.apiKey, body });
    recordKeyOutcome(cand.vendorKeyId, res.ok, res.status);
    if (res.ok && res.urls[0]) {
      videoUrl = res.urls[0];
      used = cand;
      break;
    }
    lastError = res.errorMessage || "上游创建任务失败";
  }
  if (!videoUrl || !used) throw new Error(`上游创建任务失败：${lastError}`);

  // 产物转存：Ark 给的是临时地址，必须立即下载落盘
  await patchTask(task.taskId, { stage: "下载产物", progress: 90 });
  let bytes: Buffer;
  let mime: string | null = null;
  try {
    const cr = await fetch(videoUrl, { signal: AbortSignal.timeout(VIDEO_CONTENT_TIMEOUT_MS) });
    if (!cr.ok) throw new Error(`HTTP ${cr.status}`);
    mime = (cr.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() || null;
    bytes = Buffer.from(await cr.arrayBuffer());
  } catch (e) {
    throw new Error(`下载上游视频失败：${(e as Error).message}`);
  }

  const asset = await storePlaygroundBytes({
    userId: task.userId,
    requestId: task.requestId,
    index: 0,
    bytes,
    mime,
    assetType: "video",
  });

  // 结算（预扣即结算；原子抢占保证重启并发时只结算一次）
  const settleClaim = await db.playgroundMediaTask.updateMany({
    where: { taskId: task.taskId, status: "running", stage: { not: "结算中" } },
    data: { stage: "结算中", progress: 97 },
  });
  const guestTask = isGuestTask(task);
  const paid = guestTask ? 0 : task.estCredits;
  const costM = guestTask ? 0 : pricing ? costMilli(seconds, pricing, "input") : 0;
  if (settleClaim.count > 0) {
    if (!guestTask) {
      await billing.settle(task.userId, task.requestId, paid);
      await recordUsage({
        requestId: task.requestId,
        userId: task.userId,
        channel: "onsite",
        apiKeyId: null,
        modelId: task.modelId,
        vendorKeyId: used.vendorKeyId,
        endpointType: "video",
        modelSnapshot: task.modelSnapshot,
        promptTokens: 0,
        outputTokens: 0,
        unitCount: seconds,
        costMilli: costM,
        paidCredits: paid,
        latencyMs: Date.now() - task.startedAt!.getTime(),
        status: "success",
        ...(pricing ? pricingSnapshot(pricing) : { priceVersionId: null, priceSnapshot: null }),
      });
    }
  } else {
    await new Promise((r) => setTimeout(r, 1000));
  }

  await patchTask(task.taskId, {
    status: "succeeded",
    stage: "已完成",
    progress: 100,
    vendorKeyId: used.vendorKeyId,
    resultUrls: JSON.stringify([asset.url]),
    paidCredits: BigInt(paid),
    costMilli: BigInt(costM),
    latencyMs: Date.now() - task.startedAt!.getTime(),
    finishedAt: new Date(),
    errorMessage: null,
  });
}

// ── 视频第二/三段：轮询任务 → 下载产物 → 结算落盘（提交成功后的全部流程；
//    进程重启恢复时也会从这段进入） ──
async function pollAndDeliverVideo(
  task: PlaygroundMediaTask,
  jobId: string,
  key: KeyCandidate,
  seconds: number,
  pricing: ModelPricing | null
) {
  const deadline = Date.now() + VIDEO_TOTAL_WAIT_MS;
  let upstreamProgress = 0;
  let pollError = ""; // 最近一次查询失败原因（单次抖动不判失败，只记录）
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error("视频生成等待超时（超过 20 分钟），已全额退回预扣积分");
    }
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
    let json: VideoJobStatus | null = null;
    let status = "";
    try {
      const pr = await fetch(`${baseOf(key.apiBase)}/videos/${encodeURIComponent(jobId)}`, {
        method: "GET",
        headers: authHeaders(key.apiKey),
        signal: AbortSignal.timeout(VIDEO_POLL_TIMEOUT_MS),
      });
      json = (await pr.json().catch(() => null)) as VideoJobStatus | null;
      if (!pr.ok) {
        // 单次查询失败：记录后继续等（不因一次 5xx/网络抖动判失败）
        pollError = `任务查询失败 HTTP ${pr.status}`;
        continue;
      }
      status = String(json?.status ?? "").toLowerCase();
    } catch (e) {
      pollError = (e as Error).message;
      continue;
    }

    if (typeof json?.progress === "number" && Number.isFinite(json.progress)) {
      upstreamProgress = Math.min(99, Math.max(0, Math.round(json.progress)));
    }
    // 上游没给进度时，按已等待时间给一个保守估计（只影响展示，不影响结算）
    const elapsedRatio = 1 - (deadline - Date.now()) / VIDEO_TOTAL_WAIT_MS;
    const shown = upstreamProgress > 0 ? upstreamProgress : Math.min(90, 10 + Math.round(elapsedRatio * 80));
    await patchTask(task.taskId, {
      stage: status === "queued" ? "排队中" : "生成中",
      progress: shown,
    }).catch(() => {});

    if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled") {
      const code = typeof json?.error?.code === "string" ? json.error.code : "";
      const msg = typeof json?.error?.message === "string" ? json.error.message : "";
      throw new Error(`上游任务失败${code ? `（${code}）` : ""}${msg ? `：${msg}` : ""}`);
    }
    if (status === "completed") break;
  }

  // 3) 取产物（需要 Authorization，直接下到内存再落盘）
  await patchTask(task.taskId, { stage: "下载产物", progress: 92 });
  let bytes: Buffer;
  let mime: string | null = null;
  try {
    const cr = await fetch(`${baseOf(key.apiBase)}/videos/${encodeURIComponent(jobId)}/content`, {
      method: "GET",
      headers: authHeaders(key.apiKey),
      signal: AbortSignal.timeout(VIDEO_CONTENT_TIMEOUT_MS),
    });
    if (!cr.ok) throw new Error(`HTTP ${cr.status}`);
    mime = (cr.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() || null;
    bytes = Buffer.from(await cr.arrayBuffer());
  } catch (e) {
    throw new Error(`下载上游视频失败：${(e as Error).message}`);
  }

  const asset = await storePlaygroundBytes({
    userId: task.userId,
    requestId: task.requestId,
    index: 0,
    bytes,
    mime,
    assetType: "video",
  });

  // 结算：按创建时定格的统一秒价（estCredits）结算，成本按后台每秒成本价核算。
  // 原子抢占「结算中」：重启恢复与原进程并发时，保证 settle / 记用量只执行一次。
  const settleClaim = await db.playgroundMediaTask.updateMany({
    where: { taskId: task.taskId, status: "running", stage: { not: "结算中" } },
    data: { stage: "结算中", progress: 97 },
  });
  const guestTask = isGuestTask(task);
  const paid = guestTask ? 0 : task.estCredits;
  const costM = guestTask || !pricing ? 0 : costMilli(seconds, pricing, "input");
  if (settleClaim.count > 0) {
    if (!guestTask) {
      await billing.settle(task.userId, task.requestId, paid);
      await recordUsage({
        requestId: task.requestId,
        userId: task.userId,
        channel: "onsite",
        apiKeyId: null,
        modelId: task.modelId,
        vendorKeyId: key.vendorKeyId,
        endpointType: "video",
        modelSnapshot: task.modelSnapshot,
        promptTokens: 0,
        outputTokens: 0,
        unitCount: seconds,
        costMilli: costM,
        paidCredits: paid,
        latencyMs: Date.now() - task.startedAt!.getTime(),
        status: "success",
        ...(pricing ? pricingSnapshot(pricing) : { priceVersionId: null, priceSnapshot: null }),
      });
    }
  } else {
    // 结算已被其它实例完成（重启恢复并发窗口），稍候一拍再补终态
    await new Promise((r) => setTimeout(r, 1000));
  }

  await patchTask(task.taskId, {
    status: "succeeded",
    stage: "已完成",
    progress: 100,
    vendorKeyId: key.vendorKeyId,
    resultUrls: JSON.stringify([asset.url]),
    paidCredits: BigInt(paid),
    costMilli: BigInt(costM),
    latencyMs: Date.now() - task.startedAt!.getTime(),
    finishedAt: new Date(),
    errorMessage: null,
  });
  const elapsed = ((Date.now() - task.startedAt!.getTime()) / 1000).toFixed(1);
  await syncTaskMessage(
    task.taskId,
    `已完成${task.requestSize ? ` · ${task.requestSize}` : ""} · ${elapsed}s`
  );
}

// 执行入口（fire-and-forget）：原子抢占（queued 或租约过期的 running）→ 执行 → 释放租约
export async function runMediaTask(taskId: string) {
  if (!(await claimMediaTask(taskId))) return;
  const stopRenew = startMediaLeaseRenewal(taskId);
  try {
    // 首次执行补 startedAt；被接管重跑时保留原值（耗时口径不重置）
    await db.playgroundMediaTask.updateMany({ where: { taskId, startedAt: null }, data: { startedAt: new Date() } });
    const task = await db.playgroundMediaTask.findUnique({ where: { taskId } });
    if (!task) return;
    // 盖上本进程 bootId：重启恢复据此跳过本进程在跑的任务
    await db.playgroundMediaTask
      .update({
        where: { taskId },
        data: { params: JSON.stringify({ ...parseParams(task.params), bootId: PROCESS_BOOT_ID }) },
      })
      .catch(() => {});
    if (task.kind === "video") await runVideo(task);
    else await runImage(task);
  } catch (e) {
    console.error(`[playground-task] 任务失败 taskId=${taskId}`, e);
    const task = await db.playgroundMediaTask.findUnique({ where: { taskId } });
    if (task) await failTask(task, (e as Error).message || "生成失败");
  } finally {
    stopRenew();
    // 终态/异常都清租约，避免残留 lockedUntil 影响下一次统计
    await db.playgroundMediaTask
      .updateMany({ where: { taskId, workerId: MEDIA_WORKER_ID }, data: { lockedUntil: null } })
      .catch(() => {});
  }
}

// 路由层调用：不 await，立即把 taskId 返回给前端。
// 有 REDIS_URL 时入队由独立 Worker 进程消费（图片走独立通道、视频并入视频线）；
// 入队失败（Redis 抖动 / 本地未配 Redis）回退本进程执行，任务不滞留。
export function startMediaTask(taskId: string, kind: "image" | "video") {
  cleanupOldTasks();
  const inline = () => {
    void runMediaTask(taskId).catch((e) => {
      console.error(`[playground-task] 任务执行异常 taskId=${taskId}`, e);
    });
  };
  if (!process.env.REDIS_URL) {
    inline();
    return;
  }
  void import("@/lib/queue/media-queue")
    .then((m) => m.enqueuePlaygroundMedia(kind, taskId))
    .then((r) => {
      if (!r.ok) {
        console.warn(`[playground-task] 入队失败，回退本进程执行 taskId=${taskId}: ${r.error || ""}`);
        inline();
      }
    })
    .catch(() => inline());
}

// ── 进程重启恢复 ──
// 纯函数决策（便于单测）：非终态任务在进程重启后该怎么办。
//   queued  → rerun   ：worker 还没执行过，重新排队即可（runMediaTask 原子抢占保证不重复）
//   running + 视频有 upstreamJobId → resume：上游任务还在跑，恢复轮询，不重复提交/扣费
//   running 其它情况 → fail    ：上游请求已随旧进程消失（图片同步调用无法续传、
//                                视频 jobId 未落库），如实置失败并全额退分
// running 任务如果 params.bootId == 当前进程 → 是本进程在跑的任务，绝不能碰（none）。
export type RecoveryDecision = "rerun" | "resume" | "fail" | "none";

export function recoveryDecisionFor(
  task: { kind: string; status: string; params: string },
  currentBootId: string
): RecoveryDecision {
  if (task.status === "queued") return "rerun";
  if (task.status !== "running") return "none";
  // 本进程在跑的任务：bootId 相同（或刚被本进程盖过章），恢复逻辑不许碰
  if (parseParams(task.params).bootId === currentBootId) return "none";
  if (task.kind === "video" && parseParams(task.params).upstreamJobId) return "resume";
  return "fail";
}

// 视频恢复：找到原 Key 候选（按 vendorKeyId 匹配），从中断处继续轮询
async function resumeVideo(task: PlaygroundMediaTask) {
  const jobId = parseParams(task.params).upstreamJobId ?? "";
  if (!jobId) {
    await failTask(task, "服务重启导致任务中断（缺少上游任务号），预扣积分已全额退回");
    return;
  }
  const route = await resolveRoute(task.modelSnapshot);
  const key = route?.candidates.find((c) => c.vendorKeyId === task.vendorKeyId);
  if (!key) {
    await failTask(task, "服务重启后无法恢复上游连接（渠道 Key 变更），预扣积分已全额退回");
    return;
  }
  const stored = parseParams(task.params);
  const seconds = Math.max(1, stored.duration ?? 5);
  const pricing = videoPricingForVariant(
    route,
    videoVariantFromBody({ resolution: stored.resolution ?? "720p", reference_videos: stored.referenceVideos ?? [] })
  );
  await pollAndDeliverVideo(task, jobId, key, seconds, pricing).catch(async (e) => {
    console.error(`[playground-task] 恢复任务失败 taskId=${task.taskId}`, e);
    await failTask(task, (e as Error).message || "恢复任务失败");
  });
}

// 开机/巡检调用：扫 queued 与「租约过期」的 running 任务并按决策处理。
// 只处理租约过期的 running，避免把别的实例正在跑的任务误判为死任务。
export async function recoverStaleTasks() {
  const now = new Date();
  const leaseCutoff = new Date(now.getTime() - MEDIA_LEASE_MS);
  const queued = await db.playgroundMediaTask.findMany({ where: { status: "queued" } });
  for (const t of queued) {
    if (t.attempts >= MEDIA_MAX_ATTEMPTS) {
      console.log(`[playground-task] 排队任务重试次数超限，收口 taskId=${t.taskId}`);
      await failTask(t, "任务多次重试仍未完成，预扣积分已全额退回");
      continue;
    }
    console.log(`[playground-task] 恢复排队任务 taskId=${t.taskId}`);
    startMediaTask(t.taskId, t.kind === "video" ? "video" : "image");
  }

  const running = await db.playgroundMediaTask.findMany({
    where: {
      status: "running",
      OR: [{ lockedUntil: { lt: now } }, { lockedUntil: null, updatedAt: { lt: leaseCutoff } }],
    },
  });
  for (const t of running) {
    const decision = recoveryDecisionFor(t, PROCESS_BOOT_ID);
    if (decision === "rerun" || decision === "none") continue;
    if (decision === "resume") {
      const claimed = await db.playgroundMediaTask.updateMany({
        where: {
          taskId: t.taskId,
          status: "running",
          stage: { not: "恢复中" },
          attempts: { lt: MEDIA_MAX_ATTEMPTS },
        },
        data: {
          stage: "恢复中",
          attempts: { increment: 1 },
          lockedUntil: new Date(Date.now() + MEDIA_LEASE_MS),
          workerId: MEDIA_WORKER_ID,
        },
      });
      if (claimed.count === 0) continue;
      console.log(`[playground-task] 恢复视频轮询 taskId=${t.taskId}`);
      const stopRenew = startMediaLeaseRenewal(t.taskId);
      void resumeVideo(t)
        .catch((e) => {
          console.error(`[playground-task] 恢复执行异常 taskId=${t.taskId}`, e);
        })
        .finally(stopRenew);
    } else {
      const claimed = await db.playgroundMediaTask.updateMany({
        where: { taskId: t.taskId, status: "running", stage: { not: "恢复中" } },
        data: { stage: "恢复中" },
      });
      if (claimed.count === 0) continue;
      console.log(`[playground-task] 任务中断收口 taskId=${t.taskId}`);
      await failTask(t, "服务重启导致任务中断，预扣积分已全额退回");
    }
  }
}
