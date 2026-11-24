import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getActiveUser } from "@/lib/auth";
import { billing } from "@/lib/gateway/billing";
import { resolveRequestId } from "@/lib/gateway/idempotency";
import { callChatForProtocol } from "@/lib/gateway/adapters";
import { checkChatParams } from "@/lib/gateway/capabilities";
import {
  displayMemberCredits,
  estimateCredits,
  pricingSnapshot,
  totalCostMilli,
} from "@/lib/gateway/pricing";
import {
  markKeyUsed,
  recordKeyCancelled,
  recordKeyOutcome,
  releaseKeyProbe,
  resolveRoute,
  tryAcquireKeyCall,
  type KeyCandidate,
} from "@/lib/gateway/router";
import { recordUsage, type UsageInput } from "@/lib/gateway/usage";
import { acquireSlot, checkQuota, getQuotaConfig } from "@/lib/quota";
import { maskSensitive, prepareSkillMaterial } from "@/lib/playground/safety";
import { consumeGuestTrial, getPlaygroundSettings } from "@/lib/playground/settings";
import { getClientIp } from "@/lib/rbac";

// pa 组口径：会员每人最多 50 个会话 / 单个会话最多 200 条消息
const MAX_SESSIONS_PER_USER = 50;
const MAX_MESSAGES_PER_SESSION = 200;

export const dynamic = "force-dynamic";

// ─── 冰山实验场：站内对话接口（SSE） ───
// 与 /v1/chat/completions 同一套路由 / 计费 / 用量落库，区别只有两点：
//   1) 鉴权用站内登录态（cookie token），不要求 API Key；
//   2) 不走 /v1 的网关域名白名单（实验场只在主站域名下由页面调用）。
// 计费语义不变：预检 → 预扣 → 上游流式 → 结算；用量写 usage_record（channel=onsite）。
// 注意：前台不展示任何「本次消耗 X 积分」文案，扣费明细统一在会员中心查看。

const chatSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().max(20000),
      })
    )
    .min(1)
    .max(40),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().min(16).max(8192).optional(),
  // M2：续聊时带上会话 id；不传则本次对话新建会话
  sessionId: z.number().int().positive().optional(),
  // M3：挂载技能（服务端按白名单校验后作为 system 素材注入，客户端不传技能正文）
  skillIds: z.array(z.number().int().positive()).max(2).optional(),
});

// 从上游 SSE 原始流中还原 assistant 全文（只取 delta.content），用于落库
function extractSseText(raw: string): string {
  let out = "";
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
      const piece = j.choices?.[0]?.delta?.content;
      if (typeof piece === "string") out += piece;
    } catch {
      /* 忽略心跳 / 非 JSON 行 */
    }
  }
  return out;
}

function fail(status: number, error: string, code?: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, code, ...(extra ?? {}) }, { status });
}

export async function POST(req: NextRequest) {
  // pa1 实验场总开关：先于参数校验与鉴权分支，关闭时所有对话请求一律拒绝
  const pgSettings = await getPlaygroundSettings();
  if (pgSettings.enabled === false) {
    return fail(403, "实验场已关闭", "playground_closed");
  }

  // ── 1. 站内登录态 / 游客试玩 ──
  const { user, state } = await getActiveUser();
  if (state === "suspended") {
    return fail(403, "账号已被封禁，无法使用实验场", "account_suspended");
  }

  // ── 2. 请求体校验 ──
  const raw = await req.json().catch(() => null);
  const parsed = chatSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(400, "请求参数不合法：" + (parsed.error.issues[0]?.message || ""), "invalid_body");
  }
  const body = parsed.data;

  // ── 2.1 游客：未开启直接要求登录；已开启按次放行，不计费不落会话 ──
  const guestCfg = pgSettings.guest;
  let guest = false;
  let guestIp = "";
  let guestRemaining: number | null = null;
  if (!user) {
    if (!guestCfg.enabled) {
      return fail(401, "请先登录或注册后再使用实验场", "not_authenticated", {
        loginUrl: "/login?next=/playground",
      });
    }
    guest = true;
    guestIp = (await getClientIp()) || "unknown";
  }
  const actorId = user?.id ?? 0;

  // ── 2.2 会话上限（仅会员）：50 个会话 / 单会话 200 条消息 ──
  if (!guest) {
    if (body.sessionId) {
      const owned = await db.playgroundSession.findFirst({
        where: { id: body.sessionId, userId: actorId },
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
      }
    } else {
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

  // ── 2.5 技能挂载（M3）：服务端取正文、校验白名单、清洗后作为 system 素材注入 ──
  // 客户端只传 skillId，不传技能正文，避免绕过白名单直接投喂任意内容。
  const skillMaterials: string[] = [];
  if (body.skillIds?.length) {
    const ids = [...new Set(body.skillIds)];
    const rows = await db.skill.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, slug: true, status: true, featured: true, skillMd: true },
    });
    if (rows.length !== ids.length) {
      return fail(404, "技能不存在或已下线", "skill_not_found");
    }
    for (const row of rows) {
      const built = prepareSkillMaterial(row);
      if (!built.ok) {
        return fail(403, `技能「${row.name}」暂不能在实验场运行：${built.reason}`, "skill_not_whitelisted");
      }
      skillMaterials.push(built.material);
    }
  }
  const upstreamMessages =
    skillMaterials.length > 0 || pgSettings.persona
      ? [
          {
            role: "system" as const,
            // pa8：平台级人设提示词置顶（空则不注入），技能素材随后
            content: [pgSettings.persona, ...skillMaterials].filter(Boolean).join("\n\n"),
          },
          ...body.messages,
        ]
      : body.messages;

  // ── 3. 会员层配额（日次数 + 每分钟次数）；游客先扣试玩次数（校验通过后才扣，避免无效请求浪费额度） ──
  if (guest) {
    const trial = await consumeGuestTrial(guestIp, guestCfg.maxTrials);
    if (!trial.ok) {
      return fail(429, "游客试玩次数已用完，请登录或注册后继续", "guest_trial_exhausted", {
        loginUrl: "/login?next=/playground",
      });
    }
    guestRemaining = trial.remaining;
  } else {
    const quota = await checkQuota(actorId);
    if (!quota.ok) {
      const notice = pgSettings.rateLimitNotice;
      return fail(429, quota.error ? `${notice}（${quota.error}）` : notice, "quota_exceeded");
    }
  }

  // ── 4. 模型 / 端点 / 定价 ──
  const route = await resolveRoute(body.model);
  if (!route) return fail(404, "模型不存在或已下线", "model_not_found");
  const endpoint = route.endpoints.find((e) => e.path === "chat_completions" && e.enabled);
  if (!endpoint) return fail(404, "该模型暂不支持对话", "endpoint_disabled");
  const pricing = route.pricing;
  if (!pricing) return fail(404, "该模型暂未配置价格", "pricing_not_configured");

  // 能力协商：模型声明了参数白名单时，白名单外参数拒绝（与网关一致）
  const upstreamBody: Record<string, unknown> = {
    model: body.model,
    messages: upstreamMessages,
    stream: true,
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
    ...(body.max_tokens != null ? { max_tokens: body.max_tokens } : {}),
  };
  const capCheck = checkChatParams(route.model.capabilities, upstreamBody);
  if (!capCheck.ok) {
    return fail(400, `该模型不支持参数：${capCheck.unsupported.join(", ")}`, "unsupported_parameter");
  }

  // L1：绑定端点 + 模型 + 请求体指纹（含 skillIds），防止同一 Key 跨端点/换参数复用旧扣费
  const requestId = resolveRequestId(actorId, req, { endpoint: "playground.chat", model: body.model, body });
  const started = Date.now();
  const estInput = Math.ceil(JSON.stringify(upstreamMessages).length / 4);
  const estOutput = body.max_tokens ?? 1024;
  const estCredits = estimateCredits({ pricings: [pricing] }, { input: estInput, output: estOutput });

  const baseUsage: Omit<UsageInput, "status" | "costMilli" | "paidCredits" | "vendorKeyId"> = {
    requestId,
    userId: actorId,
    channel: "onsite",
    apiKeyId: null,
    modelId: route.model.id,
    endpointType: "chat",
    modelSnapshot: body.model,
    promptTokens: 0,
    outputTokens: 0,
  };

  // ── 5. 预检（会员；游客不计费不退款） ──
  // g19：文本不再预扣，成功后按实际用量结算；失败/取消未产生消费时不写任何流水。
  if (!guest) {
    const pre = await billing.preCheck(actorId, estCredits, "chat");
    if (!pre.ok) return fail(402, "积分不足，请先到会员中心充值后再试", "insufficient_credits");
  }

  // ── 6. 并发槽（出口必须 release；游客共用一个槽位，不占会员计数） ──
  const quotaCfg = await getQuotaConfig();
  const slot = guest
    ? { ok: true, release: () => {} }
    : await acquireSlot(actorId, quotaCfg.concurrency);
  if (!slot.ok) {
    if (!guest) await billing.refund(actorId, requestId);
    return fail(429, "正在生成中，请等待当前回复结束", "concurrency_exceeded");
  }

  // ── 7. 选 Key + 上游调用（失败换 Key，最多 3 个） ──
  const ac = new AbortController();
  const onClientAbort = () => ac.abort();
  req.signal?.addEventListener("abort", onClientAbort, { once: true });

  const attempts: KeyCandidate[] = route.candidates.slice(0, 3);
  if (attempts.length === 0) {
    req.signal?.removeEventListener("abort", onClientAbort);
    slot.release();
    if (!guest) {
      await billing.refund(actorId, requestId);
      await recordUsage({
        ...baseUsage,
        vendorKeyId: null,
        status: "failed",
        costMilli: 0,
        paidCredits: 0,
        latencyMs: Date.now() - started,
      });
    }
    return fail(502, "该模型暂无可用的上游通道，请联系站长", "no_upstream_key");
  }

  let result = null as Awaited<ReturnType<typeof callChatForProtocol>> | null;
  let used: KeyCandidate | null = null;
  let lastError = "";
  // 真正向上游发出过几次请求：等待阶段断连时据此区分「平台是否有成本」
  let upstreamCalls = 0;
  for (const cand of attempts) {
    // 客户端已断连（含进入本次调用前就断开）：不再消耗上游
    if (ac.signal.aborted || req.signal?.aborted) break;
    // U2：真正调用前才占用半开探测名额；名额已被占用则跳过该 Key
    if (!tryAcquireKeyCall(cand.vendorKeyId)) continue;
    markKeyUsed(cand.vendorKeyId);
    let r: Awaited<ReturnType<typeof callChatForProtocol>>;
    try {
      upstreamCalls++;
      r = await callChatForProtocol({
        protocol: route.vendor.protocol,
        apiBase: cand.apiBase,
        apiKey: cand.apiKey,
        body: upstreamBody,
        signal: ac.signal,
      });
    } catch (e) {
      releaseKeyProbe(cand.vendorKeyId); // 异常退出也要归还探测名额
      throw e;
    }
    // 客户端主动断连不算上游失败：不进熔断窗口、不推高失败率（aborted 由 adapter 三条件判定）
    if (r.aborted) {
      recordKeyCancelled(cand.vendorKeyId);
      break;
    }
    recordKeyOutcome(cand.vendorKeyId, r.ok, r.ok ? 200 : r.status || 502);
    if (r.ok) {
      result = r;
      used = cand;
      break;
    }
    lastError = r.errorMessage || `HTTP ${r.status}`;
  }

  // 客户端在等待阶段断连：按「是否已把请求发给上游」分两种口径
  //   ① 一次上游请求都没发出：平台无成本 → 全额退回预扣
  //   ② 已发出但响应未知：上游可能已按输入计费 → 只收已发送的输入 token，差额退回
  if ((ac.signal.aborted || req.signal?.aborted) && !result) {
    req.signal?.removeEventListener("abort", onClientAbort);
    slot.release();
    if (!guest) {
      if (upstreamCalls === 0) {
        await billing.refund(actorId, requestId);
        await recordUsage({
          ...baseUsage,
          vendorKeyId: null,
          // 客户端取消：不是上游失败，不污染失败率统计
          status: "cancelled",
          costMilli: 0,
          paidCredits: 0,
          latencyMs: Date.now() - started,
        });
      } else {
        const held = displayMemberCredits(pricing, estInput, 0);
        await billing.settle(actorId, requestId, held);
        await recordUsage({
          ...baseUsage,
          vendorKeyId: used?.vendorKeyId ?? null,
          promptTokens: estInput,
          outputTokens: 0,
          costMilli: totalCostMilli(pricing, estInput, 0),
          paidCredits: held,
          status: "cancelled",
          latencyMs: Date.now() - started,
          ...pricingSnapshot(pricing),
        });
      }
    }
    return fail(499, "请求已取消", "client_cancelled");
  }

  if (!result || !used) {
    req.signal?.removeEventListener("abort", onClientAbort);
    slot.release();
    if (!guest) {
      await billing.refund(actorId, requestId);
      await recordUsage({
        ...baseUsage,
        vendorKeyId: null,
        status: "failed",
        costMilli: 0,
        paidCredits: 0,
        latencyMs: Date.now() - started,
      });
    }
    console.error(`[playground] upstream error model=${body.model}: ${lastError}`);
    return fail(502, "模型服务暂时不可用，请稍后重试", "upstream_error");
  }

  // ── 8. 结算（实际用量结算，断连按已发生用量）；游客无账可结 ──
  const settleOnce = async (status: "success" | "failed" | "cancelled") => {
    try {
      const usage = result!.usageRef.current || { promptTokens: estInput, completionTokens: 0 };
      if (!guest) {
        const costM = totalCostMilli(pricing, usage.promptTokens, usage.completionTokens);
        const paid = displayMemberCredits(pricing, usage.promptTokens, usage.completionTokens);
        if (status === "failed") {
          await billing.refund(actorId, requestId);
        } else {
          await billing.settle(actorId, requestId, paid);
        }
        await recordUsage({
          ...baseUsage,
          vendorKeyId: used!.vendorKeyId,
          promptTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          costMilli: costM,
          paidCredits: status === "failed" ? 0 : paid,
          latencyMs: Date.now() - started,
          status,
          ...pricingSnapshot(pricing),
        });
      }
      // 渠道健康：cancelled 视作中性（取消不是上游质量信号），failed 记失败，success 记成功
      if (status === "cancelled") {
        recordKeyCancelled(used!.vendorKeyId);
      } else {
        recordKeyOutcome(used!.vendorKeyId, status !== "failed", status === "failed" ? 502 : 200);
      }
    } finally {
      req.signal?.removeEventListener("abort", onClientAbort);
      slot.release();
    }
  };

  const upstreamStream = result.stream;
  if (!upstreamStream) {
    await settleOnce("failed");
    return fail(502, "模型服务未返回内容，请稍后重试", "upstream_error");
  }

  // ── 9. 会话归属：带 sessionId 校验归属，否则本次对话新建（响应头回传给前端） ──
  // 游客不落会话、不存历史，只返回本次流式结果。
  let sessionId: number | null = null;
  let createdHere = false;
  if (!guest) {
    if (body.sessionId) {
      const owned = await db.playgroundSession.findFirst({
        where: { id: body.sessionId, userId: actorId },
        select: { id: true },
      });
      if (owned) sessionId = owned.id;
    }
    if (!sessionId) {
      const firstUserText =
        [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const created = await db.playgroundSession.create({
        data: {
          userId: actorId,
          modelName: body.model,
          title: maskSensitive(firstUserText.trim().slice(0, 24)).text || "新对话",
        },
        select: { id: true },
      });
      sessionId = created.id;
      createdHere = true;
    }
  }
  const sessionKey = sessionId;

  // 落库：正常结束或用户中途停止都保存已生成内容（失败的请求不落库；游客不落库）
  const persistTurn = async (assistantText: string) => {
    if (guest || sessionKey == null) return;
    const text = assistantText.trim();
    if (!text) {
      // 空回复（典型：token 全被 reasoning 吃掉 / 上游只回空 delta）：
      // 不落空消息，也不留空壳会话——本次新建的会话在确认无消息后直接删掉。
      if (createdHere) {
        try {
          const msgCount = await db.playgroundMessage.count({ where: { sessionId: sessionKey } });
          if (msgCount === 0) {
            await db.playgroundSession.deleteMany({ where: { id: sessionKey, userId: actorId } });
            console.warn(`[playground] 空回复，已清理本次新建的空会话 sessionId=${sessionKey}`);
          }
        } catch (e) {
          console.error("[playground] cleanup empty session failed:", e);
        }
      }
      return;
    }
    const lastUserText =
      [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const usage = result!.usageRef.current;
    try {
      if (lastUserText.trim()) {
        await db.playgroundMessage.create({
          data: {
            sessionId: sessionKey,
            role: "user",
            // M3：落库前脱敏（手机号/身份证/银行卡/邮箱/密钥）；发往上游的请求保持原样
            content: maskSensitive(lastUserText).text.slice(0, 20000),
            promptTokens: usage?.promptTokens ?? 0,
          },
        });
      }
      await db.playgroundMessage.create({
        data: {
          sessionId: sessionKey,
          role: "assistant",
          content: maskSensitive(text).text.slice(0, 20000),
          outputTokens: usage?.completionTokens ?? 0,
        },
      });
      await db.playgroundSession.update({
        where: { id: sessionKey },
        data: { modelName: body.model },
      });
    } catch (e) {
      console.error("[playground] persist turn failed:", e);
    }
  };

  const reader = upstreamStream.getReader();
  const decoder = new TextDecoder();
  let rawSse = "";
  let finalized = false;
  const finalize = async (status: "success" | "failed" | "cancelled") => {
    if (finalized) return;
    finalized = true;
    await settleOnce(status).catch(() => {});
    if (status !== "failed") {
      rawSse += decoder.decode();
      await persistTurn(extractSseText(rawSse));
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          rawSse += decoder.decode(value, { stream: true });
          controller.enqueue(value);
        }
        controller.close();
        await finalize("success");
      } catch (e) {
        try {
          controller.error(e);
        } catch {}
        // 客户端已断连时读流报错属于取消，不是上游失败（熔断统计按中性处理）
        await finalize(ac.signal.aborted ? "cancelled" : "failed");
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      await finalize("cancelled");
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...(sessionKey != null ? { "X-Playground-Session-Id": String(sessionKey) } : {}),
      ...(guestRemaining != null ? { "X-Playground-Guest-Remaining": String(guestRemaining) } : {}),
      ...(skillMaterials.length > 0 ? { "X-Playground-Skills": String(skillMaterials.length) } : {}),
    },
  });
}
