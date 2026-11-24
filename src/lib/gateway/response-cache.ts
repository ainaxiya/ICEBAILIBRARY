import { db } from "@/lib/db";

// ─── 响应级幂等（v0.94）：同一 Idempotency-Key 的成功响应直接回放 ───
// 背景：requestId 幂等只保证「不重复扣费」，重试仍会再打一次上游并再产出一个产物。
// 本模块在计费预扣之前拦一道：命中原请求的成功响应 → 原样回放，不调上游、不扣费。
//
// 约定：
//   · 只缓存成功（2xx）响应；失败一律释放记录，重试可以重新执行（否则一次失败会堵死重试）。
//   · 只对携带 Idempotency-Key 的请求生效；未携带时 requestId 是随机 UUID，天然不去重。
//   · 不存二进制：媒体响应体里是我们自己的资产 URL（asset_id + /api/member/assets/...），
//     二进制在对象存储；超大 JSON（>256KB，多为 base64 内联）不缓存，避免库膨胀。
//   · 存储：idempotency_record，requestId 唯一；pending 行的 expiresAt 是「接管阈值」，
//     completed 行的 expiresAt 是回放有效期（默认 24h）。
//   · 与计费 :decision / :settle / :refund 决策行无冲突：那些是账本后缀行，
//     本表按 requestId 主键索引，读写都不触碰账本。

// 回放有效期：24h。过期后视为新请求（重新生成、重新计费），并惰性删掉旧记录。
const REPLAY_TTL_MS = 24 * 3600_000;
// pending 接管阈值：超过该时长仍未完成（进程崩溃/重启）由新请求接管，避免永久 409。
const PENDING_STALE_MS = 15 * 60_000;
// 响应体上限：超过则不缓存（典型是上游把 base64 塞进 JSON 的模型）
const MAX_BODY_CHARS = 256 * 1024;

export type IdempotencyBegin =
  | { kind: "none" }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "in_progress"; retryAfterSec: number };

// 客户端是否真的带了幂等键（未带时不做响应缓存）
export function hasClientIdempotencyKey(req: Request): boolean {
  return !!(req.headers.get("idempotency-key") || "").trim();
}

// 进入请求：登记 pending / 命中回放 / 命中执行中
export async function beginIdempotentRequest(opts: {
  requestId: string;
  userId: number;
  endpoint: string;
  keyed: boolean;
}): Promise<IdempotencyBegin> {
  if (!opts.keyed) return { kind: "none" };
  const now = new Date();

  let existing = null as Awaited<ReturnType<typeof db.idempotencyRecord.findUnique>>;
  try {
    existing = await db.idempotencyRecord.findUnique({ where: { requestId: opts.requestId } });
  } catch (e) {
    // 幂等表不可用不能阻断主链路：退化为「无响应缓存」
    console.error("[response-cache] 查询幂等记录失败，退化为不去重", e);
    return { kind: "none" };
  }

  if (existing) {
    if (existing.expiresAt.getTime() <= now.getTime()) {
      // 已过期：删掉旧记录，走全新请求
      await db.idempotencyRecord
        .delete({ where: { requestId: opts.requestId } })
        .catch(() => {});
    } else if (existing.status === "completed") {
      return { kind: "replay", status: existing.responseStatus ?? 200, body: existing.responseBody };
    } else if (now.getTime() - existing.updatedAt.getTime() < PENDING_STALE_MS) {
      return { kind: "in_progress", retryAfterSec: 5 };
    } else {
      // 首个请求疑似崩死：接管（续命 pending），继续执行
      await db.idempotencyRecord
        .update({
          where: { requestId: opts.requestId },
          data: { expiresAt: new Date(now.getTime() + PENDING_STALE_MS) },
        })
        .catch(() => {});
      return { kind: "none" };
    }
  }

  try {
    await db.idempotencyRecord.create({
      data: {
        requestId: opts.requestId,
        userId: opts.userId,
        endpoint: opts.endpoint,
        status: "pending",
        expiresAt: new Date(now.getTime() + PENDING_STALE_MS),
      },
    });
    return { kind: "none" };
  } catch {
    // 唯一约束冲突：并发重复请求同时到达，另一方已登记
    const row = await db.idempotencyRecord
      .findUnique({ where: { requestId: opts.requestId } })
      .catch(() => null);
    if (row?.status === "completed") {
      return { kind: "replay", status: row.responseStatus ?? 200, body: row.responseBody };
    }
    return { kind: "in_progress", retryAfterSec: 5 };
  }
}

// 成功收口：写入响应快照并转为 completed（回放有效期 24h）
export async function saveIdempotentResponse(
  requestId: string,
  status: number,
  body: unknown
): Promise<void> {
  let serialized = "";
  try {
    serialized = JSON.stringify(body ?? null);
  } catch {
    serialized = "";
  }
  if (!serialized) {
    await releaseIdempotentRequest(requestId);
    return;
  }
  if (serialized.length > MAX_BODY_CHARS) {
    // 超大响应不缓存：直接释放，后续重试按新请求处理（至少不会命中半截数据）
    await releaseIdempotentRequest(requestId);
    return;
  }
  await db.idempotencyRecord
    .update({
      where: { requestId },
      data: {
        status: "completed",
        responseStatus: status,
        responseBody: body as never,
        expiresAt: new Date(Date.now() + REPLAY_TTL_MS),
      },
    })
    .catch((e) => console.error("[response-cache] 写响应快照失败", e));
}

// 失败/中断收口：删除 pending 记录，允许同一 Key 重试
export async function releaseIdempotentRequest(requestId: string): Promise<void> {
  await db.idempotencyRecord
    .deleteMany({ where: { requestId, status: "pending" } })
    .catch(() => {});
}
