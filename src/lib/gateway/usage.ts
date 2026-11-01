import { db } from "@/lib/db";

// ─── P1 聚合网关：调用日志（usage_record） ───
// 每次网关调用一条；requestId 幂等（唯一索引 uk_usage_request，upsert 去重）。
// cost_milli = 内部成本毫积分（毛利报表）；paid_credits = 用户实扣整数积分（ceil）。

export interface UsageInput {
  requestId: string;
  userId: number;
  // onsite | apikey（站内登录态 | 站外 Bearer Key，P5 起）
  channel: "onsite" | "apikey";
  // 站外 Key ID（user_api_key，P5 落表；P1 恒为 null）
  apiKeyId?: number | null;
  modelId: number;
  // 命中的上游 VendorApiKey.id
  vendorKeyId: number | null;
  // chat | image | video | audio
  endpointType: string;
  // 模型名快照（调用时点，模型改名/删除后日志仍可读）
  modelSnapshot: string;
  promptTokens: number;
  outputTokens: number;
  unitCount?: number;
  costMilli: number;
  paidCredits: number;
  latencyMs?: number | null;
  // success | failed | blocked
  status: "success" | "failed" | "blocked";
}

// 写调用日志（requestId 幂等 upsert），返回 usage_record.id（生成资产关联用）
export async function recordUsage(input: UsageInput): Promise<bigint> {
  const data = {
    channel: input.channel,
    apiKeyId: input.apiKeyId == null ? null : BigInt(input.apiKeyId),
    modelId: BigInt(input.modelId),
    endpointType: input.endpointType,
    vendorKeyId: input.vendorKeyId == null ? null : BigInt(input.vendorKeyId),
    modelSnapshot: input.modelSnapshot,
    promptTokens: input.promptTokens,
    outputTokens: input.outputTokens,
    unitCount: input.unitCount ?? 1,
    costMilli: BigInt(Math.max(0, Math.round(input.costMilli))),
    paidCredits: BigInt(Math.max(0, Math.round(input.paidCredits))),
    latencyMs: input.latencyMs ?? null,
    status: input.status,
  };
  const row = await db.usageRecord.upsert({
    where: { requestId: input.requestId },
    create: { ...data, requestId: input.requestId, userId: input.userId },
    update: data,
  });
  // usage_record.id 为 Int，对外统一 BigInt（generated_asset.usageRecordId 语义对齐）
  return BigInt(row.id);
}
