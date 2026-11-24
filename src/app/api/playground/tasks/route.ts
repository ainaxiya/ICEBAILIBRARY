import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActiveUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { billing } from "@/lib/gateway/billing";
import { minBalanceCreditsFor } from "@/lib/gateway/credits-gate";
import { resolveRequestId } from "@/lib/gateway/idempotency";
import {
  displayMemberCredits,
  videoPricingForVariant,
  videoTaskMemberCredits,
  videoVariantFromBody,
} from "@/lib/gateway/pricing";
import { resolveRoute } from "@/lib/gateway/router";
import { checkQuota } from "@/lib/quota";
import { getPlaygroundMaintenance } from "@/lib/ops/maintenance";
import {
  imageSize,
  imageSpecFor,
  isImageRatio,
  isImageResolution,
  videoSizeFor,
} from "@/lib/playground/media-spec";
import {
  normalizeVideoResolution,
  videoCapabilityFor,
} from "@/lib/playground/video-capability";
import {
  assertAttachmentFile,
  assertReferenceVideoDuration,
  normalizeAttachmentPath,
  type AttachmentRole,
  type PlaygroundAttachment,
} from "@/lib/playground/attachments";
import {
  fetchVideoQuote,
  startMediaTask,
  toTaskView,
} from "@/lib/playground/media-task-runner";
import {
  FirstFrameError,
  assertFirstFrameFile,
  assertImageMinSide,
  firstFrameRatio,
  normalizeFirstFramePath,
} from "@/lib/playground/first-frame";
import {
  LOCKED_IMAGE_DEFAULTS,
  LOCKED_VIDEO_DEFAULTS,
  consumeGuestTrial,
  getPlaygroundEnabled,
  getPlaygroundSettings,
} from "@/lib/playground/settings";
import { getClientIp } from "@/lib/rbac";

export const dynamic = "force-dynamic";

// ─── M5：进程重启恢复 ───
// 配置 REDIS_URL 时由独立 Worker 进程统一巡检（避免 web 与 worker 双份恢复）；
// 本地未配 Redis 时仍在 web 进程内恢复一次。
const g = globalThis as { __pgTaskRecoveryScheduled?: boolean };
if (!g.__pgTaskRecoveryScheduled) {
  g.__pgTaskRecoveryScheduled = true;
  if (!process.env.REDIS_URL) {
    setTimeout(() => {
      import("@/lib/playground/media-task-runner")
        .then((m) => m.recoverStaleTasks())
        .catch((e) => console.error("[playground-task] 重启恢复失败", e));
    }, 3000).unref();
  }
}

// ─── POST /api/playground/tasks —— 实验场统一媒体任务（图/视频同一套状态机） ───
// 提交只做校验 + 报价 + 预扣 + 落库，随即返回 taskId；
// 真正的生成在后台 worker（media-task-runner）里跑，前端轮询 GET 取状态。
// 视频计费按后台填写的统一秒价（积分/秒 × 秒数）结算；
// 非 Ark 上游仍会先拿报价做可用性校验，但报价金额不再参与会员计费。

// 每会员同时在途的媒体任务上限（防止刷任务占满上游配额）
const MAX_INFLIGHT_TASKS = 2;
// 与对话接口同一口径：每人最多 50 个会话 / 单会话最多 200 条消息
const MAX_SESSIONS_PER_USER = 50;
const MAX_MESSAGES_PER_SESSION = 200;

const bodySchema = z.object({
  model: z.string().min(1),
  kind: z.enum(["image", "video"]),
  prompt: z.string().min(1).max(4000),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  // 续聊：媒体任务也归属于会话，刷新/切页/重新登录后聊天记录与产物仍可见
  sessionId: z.number().int().positive().optional(),
  // 首帧图：仅视频模型支持，且必须是本站 /uploads/ 地址（图生视频模型必填）
  imageUrl: z.string().min(1).max(2048).optional(),
  // 多模态素材：首帧 / 尾帧 / 参考图 / 参考视频（本站 /uploads/ 地址，数量按模型能力矩阵校验）
  attachments: z
    .array(
      z.object({
        role: z.enum(["first_frame", "last_frame", "reference_image", "reference_video"]),
        url: z.string().min(1).max(2048),
      })
    )
    .max(50)
    .optional(),
});

function fail(status: number, message: string, code: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, code, ...(extra ?? {}) }, { status });
}

export async function POST(req: NextRequest) {
  // pa1 实验场总开关：先于参数校验与鉴权分支，关闭时任何新建任务一律拒绝
  if ((await getPlaygroundEnabled()) === false) {
    return fail(403, "实验场已关闭", "playground_closed");
  }
  const { user, state } = await getActiveUser();
  if (state === "suspended") {
    return fail(403, "账号已被封禁，无法使用实验场", "account_suspended");
  }

  const raw = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail(400, "请求参数不合法：" + (parsed.error.issues[0]?.message ?? ""), "invalid_body");
  }

  // 维护开关：只拦新建任务，已在跑的任务不受影响
  const maintenance = await getPlaygroundMaintenance();
  if (maintenance.enabled) {
    return fail(503, maintenance.message, "playground_maintenance");
  }

  // ── 游客试玩：未开启要求登录；已开启按次放行，不计费不退款 ──
  const settings = await getPlaygroundSettings();
  let guest = false;
  let guestIp = "";
  let guestRemaining: number | null = null;
  if (!user) {
    if (!settings.guest.enabled) {
      return fail(401, "请先登录或注册后再使用实验场", "not_authenticated", {
        loginUrl: "/login?next=/playground",
      });
    }
    guest = true;
    guestIp = (await getClientIp()) || "unknown";
  }
  const actorId = user?.id ?? 0;

  const {
    model: modelName,
    kind,
    prompt,
    params = {},
    imageUrl: rawImageUrl,
    attachments: rawAttachments = [],
    sessionId: requestedSessionId,
  } = parsed.data;

  // ── 预检：模型 / 端点（提前解析，下面的素材与参数校验都以模型库能力为准） ──
  const route = await resolveRoute(modelName);
  if (!route) return fail(404, "模型不存在或已下线", "model_not_found");
  if (route.model.endpointType !== kind) {
    return fail(400, `模型类型不匹配：该模型是「${route.model.endpointType}」，请求是「${kind}」`, "kind_mismatch");
  }
  const endpointPath = kind === "video" ? "video_generations" : "image_generations";
  if (!route.endpoints.some((e) => e.path === endpointPath && e.enabled)) {
    return fail(400, `该模型没有开启 ${endpointPath} 端点，暂不能生成`, "endpoint_disabled");
  }
  // 能力只从模型库 advancedConfig 读取；库里没声明的分辨率/比例/素材一律不出现也不放行
  const videoCap =
    kind === "video" ? videoCapabilityFor(modelName, route.model.advancedConfig) : null;

  // ── 会话归属：媒体任务同样写入会话，保证刷新 / 切页 / 重新登录都读得到 ──
  let targetSessionId: number | null = null;
  if (!guest) {
    if (requestedSessionId) {
      const owned = await db.playgroundSession.findFirst({
        where: { id: requestedSessionId, userId: actorId },
        select: { id: true },
      });
      if (owned) {
        const used = await db.playgroundMessage.count({ where: { sessionId: owned.id } });
        if (used >= MAX_MESSAGES_PER_SESSION) {
          return fail(
            429,
            `当前会话消息已达 ${MAX_MESSAGES_PER_SESSION} 条上限，请新建对话`,
            "session_message_limit"
          );
        }
        targetSessionId = owned.id;
      }
    }
    if (!targetSessionId) {
      const total = await db.playgroundSession.count({ where: { userId: actorId } });
      if (total >= MAX_SESSIONS_PER_USER) {
        return fail(
          429,
          `会话数量已达 ${MAX_SESSIONS_PER_USER} 个上限，请先删除旧会话`,
          "session_limit"
        );
      }
    }
  }

  // ── 首帧图：只收本站上传地址；图生视频模型必须提供，绝不静默降级成文生视频 ──
  const needsFirstFrame = kind === "video" && videoCap?.firstFrame === true;
  let imageUrl: string | null = null;
  if (rawImageUrl) {
    if (kind !== "video") {
      return fail(400, "只有视频模型支持首帧图", "unsupported_parameter");
    }
    try {
      imageUrl = normalizeFirstFramePath(rawImageUrl);
      await assertFirstFrameFile(imageUrl);
      // 上游要求首尾帧 / 参考图宽高均 ≥300px，提前拦截，避免提交后才被上游 400 打回
      await assertImageMinSide(imageUrl);
    } catch (e) {
      if (e instanceof FirstFrameError) return fail(400, e.message, e.code);
      throw e;
    }
  }

  // ── 多模态素材：按能力矩阵校验数量；首尾帧与参考素材互斥 ──
  let lastFrameUrl: string | null = null;
  const refImages: string[] = [];
  const refVideos: string[] = [];
  if (rawAttachments.length > 0) {
    if (kind !== "video") {
      return fail(400, "只有视频模型支持参考素材", "unsupported_parameter");
    }
    const cap = videoCap!;
    for (const att of rawAttachments) {
      const role = att.role as AttachmentRole;
      const media = role === "reference_video" ? "video" : "image";
      let url: string;
      try {
        url = normalizeAttachmentPath(att.url, media);
        await assertAttachmentFile(url);
        // 参考视频：上游硬上限 30.2s，本站取 30s；图片：宽高均 ≥300px
        if (role === "reference_video") {
          await assertReferenceVideoDuration(url);
        } else {
          await assertImageMinSide(url);
        }
      } catch (e) {
        if (e instanceof FirstFrameError) return fail(400, e.message, e.code);
        throw e;
      }
      if (role === "first_frame") {
        if (!cap.firstFrame) return fail(400, "该模型不支持首帧输入", "unsupported_parameter");
        imageUrl = url;
      } else if (role === "last_frame") {
        if (!cap.lastFrame) return fail(400, "该模型不支持尾帧输入", "unsupported_parameter");
        lastFrameUrl = url;
      } else if (role === "reference_image") {
        refImages.push(url);
      } else {
        refVideos.push(url);
      }
    }
    if ((imageUrl || lastFrameUrl) && (refImages.length > 0 || refVideos.length > 0)) {
      return fail(400, "首尾帧与参考素材不能同时使用", "unsupported_parameter");
    }
    // 参考素材上限：后台只能下调，取「模型能力」与「运营上限」的较小值
    const limitImages =
      settings.limits.maxReferenceImages == null
        ? cap.maxReferenceImages
        : Math.min(cap.maxReferenceImages, settings.limits.maxReferenceImages);
    const limitVideos =
      settings.limits.maxReferenceVideos == null
        ? cap.maxReferenceVideos
        : Math.min(cap.maxReferenceVideos, settings.limits.maxReferenceVideos);
    if (refImages.length > limitImages) {
      return fail(400, `该模型最多上传 ${limitImages} 张参考图`, "unsupported_parameter");
    }
    if (refVideos.length > limitVideos) {
      return fail(400, `该模型最多上传 ${limitVideos} 个参考视频`, "unsupported_parameter");
    }
  }
  if (needsFirstFrame && !imageUrl) {
    return fail(400, "该模型是图生视频，必须提供首帧图", "first_frame_required");
  }

  // ── L2 幂等：同一 Idempotency-Key + 同一请求体 → 直接返回已有任务 ──
  // 必须在报价/预扣/落库之前判断：重复提交不能再走一遍扣费→唯一冲突→退款的链路。
  // 未带 Idempotency-Key 时 requestId 为随机 UUID，不会命中，行为与改造前一致。
  const requestId = resolveRequestId(actorId, req, {
    endpoint: `playground.tasks.${kind}`,
    model: modelName,
    body: parsed.data,
  });
  const existed = await db.playgroundMediaTask.findUnique({ where: { requestId } });
  if (existed) {
    const linked = await db.playgroundMessage.findFirst({
      where: { taskId: existed.taskId },
      select: { sessionId: true },
    });
    return NextResponse.json(
      { ok: true, task: toTaskView(existed), ...(linked ? { sessionId: linked.sessionId } : {}) },
      { status: 200 }
    );
  }

  if (!guest) {
    const quota = await checkQuota(actorId);
    if (!quota.ok) {
      const notice = settings.rateLimitNotice;
      return fail(429, quota.error ? `${notice}（${quota.error}）` : notice, "quota_exceeded");
    }
  }

  // ── 预检：定价 / 上游通道 ──
  // 视频按秒计价：分辨率档位价优先、档位留空回退统一秒价；精确档位在参数校验后确定。
  let pricing = kind === "video" ? null : route.pricing;
  if (kind !== "video" && !pricing) return fail(400, "该模型未配置定价，暂不能生成", "pricing_not_configured");
  if (route.candidates.length === 0) return fail(502, "该模型暂无可用上游渠道", "no_upstream_key");

  // ── 参数 → 上游 size（后台「锁定为默认」时强制固定值） ──
  const lockDefaults = settings.paramPolicy.lockDefaults;
  let size: string;
  let count = 1;
  let duration = 0;
  let resolution = "";
  let aspectRatio = "";
  if (kind === "image") {
    resolution = lockDefaults ? LOCKED_IMAGE_DEFAULTS.resolution : String(params.resolution ?? "1080");
    aspectRatio = lockDefaults ? LOCKED_IMAGE_DEFAULTS.ratio : String(params.aspect_ratio ?? "16:9");
    const n = lockDefaults ? LOCKED_IMAGE_DEFAULTS.count : Number(params.n ?? 1);
    if (!isImageResolution(resolution) || !isImageRatio(aspectRatio)) {
      return fail(400, `不支持的图片参数：分辨率 ${resolution} / 比例 ${aspectRatio}`, "unsupported_parameter");
    }
    const spec = imageSpecFor(modelName);
    if (!spec.resolutions.includes(resolution) || !spec.ratios.includes(aspectRatio)) {
      return fail(
        400,
        `该模型不支持 ${resolution} · ${aspectRatio}（可用：${spec.resolutions.join("/")} × ${spec.ratios.join("/")}）`,
        "unsupported_parameter"
      );
    }
    if (!Number.isFinite(n) || n < 1 || n > 4) {
      return fail(400, "生成张数需在 1–4 之间", "unsupported_parameter");
    }
    size = imageSize(resolution, aspectRatio);
    count = Math.floor(n);
  } else {
    // 视频：能力矩阵驱动校验（分辨率/比例/时长上限按具体模型，不写死 1–30）
    const cap = videoCap!;
    const isArk = route.vendor.protocol === "ark";
    resolution = lockDefaults
      ? LOCKED_VIDEO_DEFAULTS.resolution
      : normalizeVideoResolution(String(params.resolution ?? "720p"));
    // 首尾帧任务（Ark）比例必须是 adaptive，不能被「锁定默认」覆盖
    const rawRatio =
      lockDefaults && !imageUrl
        ? LOCKED_VIDEO_DEFAULTS.ratio
        : String(params.ratio ?? params.aspect_ratio ?? "16:9");
    const d = lockDefaults
      ? Math.min(Math.max(LOCKED_VIDEO_DEFAULTS.duration, cap.minDuration), cap.maxDuration)
      : Number(params.duration ?? Math.min(5, cap.maxDuration));
    if (!cap.resolutions.includes(resolution)) {
      return fail(
        400,
        `该模型不支持 ${resolution}（可用：${cap.resolutions.join(" / ")}）`,
        "unsupported_parameter"
      );
    }
    if (!cap.ratios.includes(rawRatio)) {
      return fail(
        400,
        `不支持的比例：${rawRatio}（可用：${cap.ratios.join(" / ")}）`,
        "unsupported_parameter"
      );
    }
    if (!Number.isInteger(d) || d < cap.minDuration || d > cap.maxDuration) {
      return fail(
        400,
        `视频时长需在 ${cap.minDuration}–${cap.maxDuration} 秒之间（整数秒）`,
        "unsupported_parameter"
      );
    }
    duration = d;
    if (isArk) {
      // 火山方舟：ratio 原样上报（首尾帧任务必须是 adaptive），分辨率走顶层 resolution
      aspectRatio = rawRatio;
      size = `${resolution} ${rawRatio}`;
    } else {
      // 图生视频：比例跟随首帧原图（不裁剪图片），尺寸按首帧最接近的支持比例计算
      let videoRatio = rawRatio;
      if (imageUrl) {
        const derived = await firstFrameRatio(imageUrl);
        if (derived) videoRatio = derived;
      }
      aspectRatio = videoRatio;
      const computed = videoSizeFor(resolution, videoRatio);
      if (!computed) {
        return fail(
          400,
          `不支持的视频参数：分辨率 ${resolution} / 比例 ${videoRatio}`,
          "unsupported_parameter"
        );
      }
      size = computed;
    }
    // 参数确定后选档：720p:n / 1080p:v … 档位价优先，留空回退统一秒价
    pricing = videoPricingForVariant(
      route,
      videoVariantFromBody({ resolution, reference_videos: refVideos })
    );
    if (!pricing) {
      return fail(
        400,
        "该视频模型该分辨率档位未定价，且未配置统一秒价（后台留空视为未定价），暂不能生成",
        "pricing_not_configured"
      );
    }
  }

  // ── 同时在途任务上限（游客共用一个计数池） ──
  const inflight = await db.playgroundMediaTask.count({
    where: { userId: actorId, status: { in: ["queued", "running"] } },
  });
  if (inflight >= MAX_INFLIGHT_TASKS) {
    return fail(429, `同时进行的生成任务已达 ${MAX_INFLIGHT_TASKS} 个，请等当前任务完成`, "too_many_tasks");
  }

  // ── 视频：统一按后台秒价计价；非 Ark 仍先拿上游报价做可用性校验（报价金额不再参与计费） ──
  let quoteUsd: number | null = null;
  let quoteId: string | null = null;
  let estCredits: number;
  if (kind === "video") {
    const local = videoTaskMemberCredits(pricing, duration);
    if (local == null) {
      return fail(
        400,
        "该视频模型未配置该档位价，且统一秒价为空（后台留空视为未定价），暂不能生成",
        "pricing_not_configured"
      );
    }
    estCredits = local;
    if (route.vendor.protocol !== "ark") {
      const key = route.candidates[0];
      const q = await fetchVideoQuote({
        apiBase: key.apiBase,
        apiKey: key.apiKey,
        model: modelName,
        seconds: duration,
        size,
        imageUrl,
      });
      if (!q.ok || q.usd == null || !q.quoteId) {
        return fail(
          502,
          `上游报价获取失败（${q.errorMessage || "未知原因"}），已取消下单，未扣积分`,
          "quote_unavailable"
        );
      }
      quoteUsd = q.usd;
      quoteId = q.quoteId;
    }
  } else {
    // 上面已保证非视频一定有定价；这里再做一层兜底，避免类型与运行时空值
    estCredits = pricing ? displayMemberCredits(pricing, count, 0) : 1;
  }

  // 游客：模型 / 参数 / 报价都校验通过后再扣试玩次数，无效请求不浪费额度
  if (guest) {
    const trial = await consumeGuestTrial(guestIp, settings.guest.maxTrials);
    if (!trial.ok) {
      return fail(429, "游客试玩次数已用完，请登录或注册后继续", "guest_trial_exhausted", {
        loginUrl: "/login?next=/playground",
      });
    }
    guestRemaining = trial.remaining;
  }

  // ── 余额门槛 + 预扣（会员；游客不计费不退款） ──
  let preDeduct = false;
  if (!guest) {
    const minBalance = minBalanceCreditsFor(route.model);
    const pre = await billing.preCheck(actorId, estCredits, kind, minBalance);
    if (!pre.ok) {
      if (pre.code === "min_balance_required") {
        return fail(
          402,
          `${route.model.displayName || route.model.name} 系列要求账户积分不低于 ${pre.required} 才能使用`,
          "min_balance_required",
          {
            requiredCredits: pre.required,
            balance: pre.balance,
            rechargeUrl: `/insufficient-credits?next=${encodeURIComponent("/playground")}`,
          }
        );
      }
      return fail(402, pre.error || "积分不足", "insufficient_credits");
    }
    // g19：只有 seedance 系列保留预扣（强制选秒数，按秒定价可精确预扣）；
    // 其余模型（图片 / 非 seedance 视频）成功后才按实际消费扣，失败不产生任何流水。
    const preDeductEnabled = kind === "video" && /seedance/i.test(modelName);
    preDeduct = preDeductEnabled;
    if (preDeductEnabled) {
      const deduct = await billing.preDeduct(actorId, estCredits, requestId);
      if (!deduct.ok) return fail(402, deduct.error || "积分不足", "insufficient_credits");
    }
  }

  // ── 落库 + 后台执行 ──
  // Node 18+ 全局 WebCrypto（不要 import "crypto"：webpack 会解析失败）
  const taskId = `mt-${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let task;
  try {
    task = await db.playgroundMediaTask.create({
      data: {
        taskId,
        requestId,
        userId: actorId,
        kind,
        modelId: route.model.id,
        modelSnapshot: modelName,
        status: "queued",
        stage: "排队中",
        progress: 0,
        params: JSON.stringify({
          prompt,
          count,
          duration,
          resolution,
          aspectRatio,
          // Ark 口径参数：首尾帧任务 ratio=adaptive；generate_audio 控制有声/无声
          ...(kind === "video"
            ? {
                ratio: aspectRatio,
                generateAudio: lockDefaults
                  ? videoCap!.audio
                  : params.generate_audio == null
                    ? videoCap!.audio
                    : Number(params.generate_audio) === 1,
              }
            : {}),
          ...(imageUrl ? { imageUrl } : {}),
          ...(lastFrameUrl ? { lastFrameUrl } : {}),
          ...(refImages.length ? { referenceImages: refImages } : {}),
          ...(refVideos.length ? { referenceVideos: refVideos } : {}),
        }),
        requestSize: size,
        quoteUsd,
        quoteId,
        estCredits,
      },
    });
  } catch (e) {
    // 并发重复提交（两次请求都通过了上面的 findUnique）：requestId 唯一约束抛 P2002。
    // 这是幂等命中而不是失败：返回已有任务，绝不退款（旧实现走退款分支会把已完成任务的预扣退回）。
    if ((e as { code?: string })?.code === "P2002") {
      const dup = await db.playgroundMediaTask.findUnique({ where: { requestId } });
      if (dup) {
        const linked = await db.playgroundMessage.findFirst({
          where: { taskId: dup.taskId },
          select: { sessionId: true },
        });
        return NextResponse.json(
          { ok: true, task: toTaskView(dup), ...(linked ? { sessionId: linked.sessionId } : {}) },
          { status: 200 }
        );
      }
    }
    // 其余才是真正的落库失败（连接抖动/约束异常等）：退回预扣，避免用户为没发生的任务付费
    if (!guest) await billing.refund(actorId, requestId);
    console.error("[playground-task] 创建任务失败", e);
    return fail(
      500,
      preDeduct ? "任务创建失败，已退回预扣积分" : "任务创建失败，未扣积分",
      "task_create_failed"
    );
  }

  // ── 会话落库（会员）：用户消息 + 助手占位消息（taskId 关联），任务结束后由 worker 回写文案 ──
  let sessionId: number | null = targetSessionId;
  if (!guest) {
    try {
      if (!sessionId) {
        const title = prompt.replace(/\s+/g, " ").trim().slice(0, 40) || "新媒体创作";
        const created = await db.playgroundSession.create({
          data: { userId: actorId, title, modelName },
          select: { id: true },
        });
        sessionId = created.id;
      }
      await db.playgroundMessage.createMany({
        data: [
          { sessionId, role: "user", content: prompt },
          { sessionId, role: "assistant", content: "已提交生成任务，正在处理…", taskId },
        ],
      });
      await db.playgroundSession.update({
        where: { id: sessionId },
        data: { updatedAt: new Date() },
      });
    } catch (e) {
      // 会话写入失败不影响已经创建的任务；但必须留下日志，便于按 taskId 追溯
      console.error("[playground-task] 会话消息落库失败", taskId, e);
    }
  }

  startMediaTask(taskId, kind);
  return NextResponse.json(
    {
      ok: true,
      task: toTaskView(task),
      ...(sessionId != null ? { sessionId } : {}),
      ...(guestRemaining != null ? { guestRemaining } : {}),
    },
    { status: 201 }
  );
}

// ─── GET /api/playground/tasks —— 最近任务（刷新页面恢复未完成任务用） ───
export async function GET(req: NextRequest) {
  const { user, state } = await getActiveUser();
  if (!user) {
    return state === "suspended"
      ? fail(403, "账号已被封禁，无法使用实验场", "account_suspended")
      : fail(401, "请先登录", "unauthorized");
  }
  const activeOnly = req.nextUrl.searchParams.get("active") === "1";
  const rows = await db.playgroundMediaTask.findMany({
    where: { userId: user.id, ...(activeOnly ? { status: { in: ["queued", "running"] } } : {}) },
    orderBy: { createdAt: "desc" },
    take: activeOnly ? 20 : 30,
  });
  return NextResponse.json({ ok: true, tasks: rows.map(toTaskView) });
}
