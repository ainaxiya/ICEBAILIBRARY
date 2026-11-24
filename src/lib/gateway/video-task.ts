// ─── P6 #19 异步视频任务执行器（进程内后台执行） ───
// POST /v1/videos 创建任务（预扣 + 并发槽移交）后 fire-and-forget 调本执行器：
// queued → processing（原子抢占防重复执行）→ 调上游（按 vendor.protocol 分流：
// ark → callArkVideoTask，其余 → callVideoGenerations；失败换 Key 重试最多 3 个）
// → 成功：结算 + usage + 转存产物 → succeeded；失败：全额退款 + usage failed → failed。
// 进程崩溃卡 processing 的任务：GET 惰性超时标 failed，并在同一处收口退款
// （billing.refund 幂等；已结算过则拒绝退款）。对账扫描只负责告警。
// P6 #20：REDIS_URL 配置后由 BullMQ Worker 调本执行器（原子抢占天然防多实例重复）；
// 未配置时维持进程内 inline 执行。签名按"可搬运"设计（载荷全部可序列化）。

import type { ModelPricing } from "@prisma/client";
import { db } from "@/lib/db";
import { saveGeneratedAsset } from "@/lib/assets";
import { billing } from "./billing";
import { callVideoGenerations } from "./adapters/media";
import { callArkVideoTask, type ArkVideoCallResult } from "./adapters/ark-video";
import { costMilli, displayMemberCredits, pricingSnapshot, videoTaskMemberCredits } from "./pricing";
import { markKeyUsed, recordKeyOutcome, releaseKeyProbe, tryAcquireKeyCall, type KeyCandidate } from "./router";
import { recordUsage, type UsageInput } from "./usage";

// 任务内部轮询间隔：比直连上游略快（任务在服务端后台跑，无需保守）。
// 上游建议 5–10s；这里默认 3s，可用 VIDEO_TASK_POLL_MS 覆盖（最低 1s，避免打爆上游）。
const TASK_POLL_INTERVAL_MS = Math.max(1000, Number(process.env.VIDEO_TASK_POLL_MS) || 3000);

// 计量值：video_second = 秒 × 条数；request = 1；其他按条数
// （v0.113 从 videos 路由移入：BullMQ Worker 与路由共用同一计量口径）
export function unitsForTask(pricing: { unit: string }, count: number, durationSec: number): number {
  if (pricing.unit === "request") return 1;
  if (pricing.unit === "video_second") return Math.max(1, count) * Math.max(1, durationSec);
  return Math.max(1, count);
}

// ── 队列租约（P6 #21 常驻 Worker）──
// Worker 每 60 秒续租、租约 3 分钟到期：进程崩溃后 reconciler 可在租约过期后接管重跑，
// 而不是让 processing 行永久变成孤儿。attempts 上限 3，防止无限接管。
export const LEASE_MS = 3 * 60_000;
export const LEASE_RENEW_MS = 60_000;
export const VIDEO_MAX_ATTEMPTS = 3;
export const VIDEO_WORKER_ID = `video-${process.env.HOSTNAME || "local"}-${process.pid}`;

// 原子抢占：queued，或「租约已过期」的 processing（崩溃/僵死进程遗留）都可被接管。
// 旧数据 lockedUntil 为 null 时，用 updatedAt 超过一个租约周期兜底判断。
export async function claimVideoTask(taskId: string): Promise<boolean> {
  const now = new Date();
  const claimed = await db.videoTask.updateMany({
    where: {
      taskId,
      attempts: { lt: VIDEO_MAX_ATTEMPTS },
      OR: [
        { status: "queued" },
        { status: "processing", lockedUntil: { lt: now } },
        { status: "processing", lockedUntil: null, updatedAt: { lt: new Date(now.getTime() - LEASE_MS) } },
      ],
    },
    data: {
      status: "processing",
      progress: 30,
      attempts: { increment: 1 },
      lockedUntil: new Date(now.getTime() + LEASE_MS),
      workerId: VIDEO_WORKER_ID,
    },
  });
  return claimed.count > 0;
}

// 续租：长任务（上游轮询可达数分钟）执行期间不断延长 lockedUntil，避免被 reconciler 误接管
function startLeaseRenewal(taskId: string): () => void {
  const timer = setInterval(() => {
    void db.videoTask
      .updateMany({
        where: { taskId, status: "processing", workerId: VIDEO_WORKER_ID },
        data: { lockedUntil: new Date(Date.now() + LEASE_MS) },
      })
      .catch(() => {});
  }, LEASE_RENEW_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// 执行器返回给调用方的上游补充信息（当前调用方均 fire-and-forget，不影响既有行为）
export interface VideoResult {
  // 上游视频任务 usage（Ark 查询响应有；OpenAI 兼容上游通常无）
  usage?: { completionTokens: number; totalTokens: number };
  // 上游实际出片分辨率 / 时长（Ark 查询响应；供对账快照）
  resolution?: string;
  duration?: number;
}

export async function runVideoTask(opts: {
  taskId: string;
  candidates: KeyCandidate[];
  // 上游请求体（model/prompt/n/duration/size 等，创建时定格）
  body: Record<string, unknown>;
  baseUsage: Omit<UsageInput, "status" | "costMilli" | "paidCredits" | "vendorKeyId">;
  // 创建时点定价（结算按它算，落价格快照）
  pricing: ModelPricing;
  // 结算计量：按实际产物张数/秒数换算（创建时已闭包定格 duration）
  unitsFor: (urlCount: number) => number;
  started: number;
  // 并发槽释放（POST 时 acquire，任务终态时归还）
  slotRelease: () => void;
}): Promise<VideoResult | undefined> {
  let stopRenew: (() => void) | null = null;
  try {
    // 1. 原子抢占：queued，或租约已过期的 processing（崩溃遗留）→ processing
    //    抢不到说明任务已完成/已被其它 Worker 接管，直接返回
    if (!(await claimVideoTask(opts.taskId))) return;
    stopRenew = startLeaseRenewal(opts.taskId);

    // 2. 上游执行（换 Key 重试最多 3 个）
    let urls: string[] | null = null;
    let content: { bytes: Buffer; contentType: string } | null = null;
    let used: KeyCandidate | null = null;
    let lastError = "";
    // 上游补充信息（只有 Ark 查询响应会带出来，OpenAI 兼容分支保持 undefined）
    let upstreamUsage: VideoResult["usage"];
    let upstreamResolution: string | undefined;
    let upstreamDuration: number | undefined;
    for (const cand of opts.candidates.slice(0, 3)) {
      // U2：真正调用前才占用半开探测名额；名额已被占用则跳过该 Key
      if (!tryAcquireKeyCall(cand.vendorKeyId)) continue;
      markKeyUsed(cand.vendorKeyId);
      let r: ArkVideoCallResult;
      try {
        r =
          cand.protocol === "ark"
            ? await callArkVideoTask({
                apiBase: cand.apiBase,
                apiKey: cand.apiKey,
                body: opts.body,
                pollIntervalMs: TASK_POLL_INTERVAL_MS,
              })
            : await callVideoGenerations({
                apiBase: cand.apiBase,
                apiKey: cand.apiKey,
                body: opts.body,
                pollIntervalMs: TASK_POLL_INTERVAL_MS,
                // 上游幂等：同一个计费 requestId 重试不会在上游重复建任务
                idempotencyKey: opts.baseUsage.requestId,
              });
      } catch (e) {
        releaseKeyProbe(cand.vendorKeyId); // 异常退出也要归还探测名额
        throw e;
      }
      // 产物形态二选一：URL（上游直接给地址）或二进制（OpenAI Videos /content 下载）
      const okOut = r.ok && (r.urls.length > 0 || !!r.content);
      recordKeyOutcome(cand.vendorKeyId, okOut, okOut ? 200 : r.status || 502);
      if (okOut) {
        urls = r.urls;
        content = r.content ?? null;
        upstreamUsage = r.usage;
        upstreamResolution = r.resolution;
        upstreamDuration = r.duration;
        used = cand;
        break;
      }
      lastError = r.errorMessage || `HTTP ${r.status}`;
      // 前进度（轮询执行中）
      await db.videoTask.updateMany({
        where: { taskId: opts.taskId, status: "processing", workerId: VIDEO_WORKER_ID },
        data: { progress: 60 },
      });
    }

    // 3. 全部失败：全额退款 + failed
    if (!used || ((!urls || urls.length === 0) && !content)) {
      await billing.refund(opts.baseUsage.userId, opts.baseUsage.requestId);
      await recordUsage({
        ...opts.baseUsage,
        vendorKeyId: null,
        status: "failed",
        costMilli: 0,
        paidCredits: 0,
        latencyMs: Date.now() - opts.started,
      });
      await db.videoTask.updateMany({
        where: { taskId: opts.taskId, status: "processing", workerId: VIDEO_WORKER_ID },
        data: {
          status: "failed",
          errorMessage: lastError || "upstream_error",
          latencyMs: Date.now() - opts.started,
          finishedAt: new Date(),
          lockedUntil: null,
        },
      });
      return;
    }

    // 4. 成功：结算（按实际产物数）→ usage → 转存 → succeeded
    const units = Math.max(1, opts.unitsFor(urls?.length || 1));
    const costM = costMilli(units, opts.pricing, "input");
    // 统一秒价：每秒会员价 × 实际秒数（创建时已校验已定价）
    const paid = videoTaskMemberCredits(opts.pricing, units) ?? displayMemberCredits(opts.pricing, units, 0);
    await billing.settle(
      opts.baseUsage.userId,
      opts.baseUsage.requestId,
      paid,
      opts.baseUsage.apiKeyId ?? null
    );
    const usageRecordId = await recordUsage({
      ...opts.baseUsage,
      vendorKeyId: used.vendorKeyId,
      unitCount: units,
      costMilli: costM,
      paidCredits: paid,
      latencyMs: Date.now() - opts.started,
      status: "success",
      ...pricingSnapshot(opts.pricing),
    });

    // 转存第一个产物（与 images 路由同语义：转存失败不退分，资产标 deleted）
    // 上游走 /content 下载时直接给二进制，不再绕 data URL（避免 base64 进内存与库）
    let assetId: bigint | null = null;
    const saved = await saveGeneratedAsset({
      userId: opts.baseUsage.userId,
      usageRecordId,
      assetType: "video",
      resultUrl: urls?.[0],
      content: content ?? undefined,
    });
    assetId = saved.assetId;

    // resultUrls 只留可外链的 http(s) 地址：data URL / 二进制产物已进对象存储，
    // 把 base64 写进 resultUrls 会让 video_task 行膨胀到几十 MB
    const storedUrls = (urls ?? []).filter((u) => !u.startsWith("data:"));

    await db.videoTask.updateMany({
      where: { taskId: opts.taskId, status: "processing", workerId: VIDEO_WORKER_ID },
      data: {
        status: "succeeded",
        progress: 100,
        vendorKeyId: used.vendorKeyId,
        assetId: assetId == null ? null : Number(assetId),
        resultUrls: storedUrls.length ? JSON.stringify(storedUrls) : null,
        costMilli: BigInt(Math.max(0, Math.round(costM))),
        paidCredits: BigInt(Math.max(0, Math.round(paid))),
        latencyMs: Date.now() - opts.started,
        finishedAt: new Date(),
        lockedUntil: null,
      },
    });

    // 转存失败但留有可下载的外链：补投独立产物下载队列（不占状态轮询线）
    if (assetId == null && storedUrls.length > 0) {
      void import("@/lib/queue/asset-queue")
        .then((m) =>
          m.enqueueAssetDownload({
            taskId: opts.taskId,
            userId: opts.baseUsage.userId,
            requestId: opts.baseUsage.requestId,
          })
        )
        .catch(() => {});
    }

    // 上游补充信息透传给调用方（对账/快照用；OpenAI 兼容分支为 undefined，行为不变）
    return { usage: upstreamUsage, resolution: upstreamResolution, duration: upstreamDuration };
  } catch (e) {
    // 执行器自身异常：退款 + failed（幂等保护，防与上面分支双退）
    try {
      const t = await db.videoTask.findUnique({ where: { taskId: opts.taskId } });
      if (t && (t.status === "queued" || t.status === "processing")) {
        await billing.refund(opts.baseUsage.userId, opts.baseUsage.requestId);
        await recordUsage({
          ...opts.baseUsage,
          vendorKeyId: null,
          status: "failed",
          costMilli: 0,
          paidCredits: 0,
          latencyMs: Date.now() - opts.started,
        });
        await db.videoTask.updateMany({
          where: { taskId: opts.taskId, status: { in: ["queued", "processing"] }, workerId: VIDEO_WORKER_ID },
          data: {
            status: "failed",
            errorMessage: (e as Error).message.slice(0, 500),
            finishedAt: new Date(),
            lockedUntil: null,
          },
        });
      }
    } catch {
      // 兜底：退款失败已落 billing_reconcile，由重试循环补做，不静默丢账
    }
  } finally {
    stopRenew?.();
    opts.slotRelease();
  }
}

// 收口：把无法再接管的任务置失败并退款（reconciler 用；状态原子变更保证只退一次）
export async function failVideoTask(taskId: string, reason: string): Promise<boolean> {
  const t = await db.videoTask.findUnique({ where: { taskId }, select: { userId: true, requestId: true } });
  if (!t) return false;
  const r = await db.videoTask.updateMany({
    where: { taskId, status: { in: ["queued", "processing"] } },
    data: { status: "failed", errorMessage: reason.slice(0, 500), finishedAt: new Date(), lockedUntil: null },
  });
  if (r.count === 0) return false;
  await billing.refund(t.userId, t.requestId);
  return true;
}

// 惰性超时阈值：上游提交最长 10 分钟 + 轮询总时长最长 20 分钟 = 30 分钟合法上限，
// 再留 15 分钟余量，避免把仍在合法执行的视频任务误判失败并退款。
export const STALE_PROCESSING_MS = 45 * 60_000;

// 卡死任务收口：原子改 failed（并发轮询只有一个能改成功）+ 退款。
// 状态与退款在同一处判断，保证「文案说已退款」时钱确实退回。
export async function failStaleVideoTask(task: {
  taskId: string;
  userId: number;
  requestId: string;
}): Promise<boolean> {
  const r = await db.videoTask.updateMany({
    where: {
      taskId: task.taskId,
      status: "processing",
      updatedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) },
    },
    data: { status: "failed", errorMessage: "任务执行超时（服务重启中断），费用已原路退回" },
  });
  if (r.count === 0) return false;
  // 幂等：重复轮询/已结算都不会产生第二次资金动作
  await billing.refund(task.userId, task.requestId);
  return true;
}
