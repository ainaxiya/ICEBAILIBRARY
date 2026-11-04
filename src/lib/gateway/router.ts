import type { AiModel, AiVendor, ModelEndpoint, ModelPricing } from "@prisma/client";
import { decryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { latestPricing } from "./pricing";

// ─── P1 聚合网关：Key 路由（厂商级 Key 轮换） ───
// 按模型名查 online 模型，取模型所属厂商（model.vendorId）下全部 status="active" 的
// VendorApiKey 作为候选，按 lastUsedAt 升序排序（null 视为最先）实现轮换；
// 上游失败由调用方沿候选列表换 Key 重试（最多 3 个）。

export interface KeyCandidate {
  vendorKeyId: number; // VendorApiKey.id（写入 usage_record.vendor_key_id）
  keyName: string;
  apiKey: string; // 解密后的明文 Key（内存中用完即弃，不落日志）
  apiBase: string;
}

export interface RouteContext {
  model: AiModel;
  vendor: AiVendor;
  endpoints: ModelEndpoint[];
  pricings: ModelPricing[];
  pricing: ModelPricing | null;
  candidates: KeyCandidate[];
}

// 解析模型路由：null = 模型不存在或已下线
export async function resolveRoute(modelName: string): Promise<RouteContext | null> {
  const model = await db.aiModel.findFirst({
    where: { name: modelName, status: "online" },
    include: {
      vendor: true,
      endpoints: true,
      pricings: true,
    },
  });
  if (!model) return null;

  // 厂商级 Key 轮换：active Key 按 lastUsedAt 升序（null 最先）排序
  const keys = await db.vendorApiKey.findMany({
    where: { vendorId: model.vendorId, status: "active" },
    orderBy: { lastUsedAt: { sort: "asc", nulls: "first" } },
  });

  const candidates: KeyCandidate[] = [];
  for (const k of keys) {
    try {
      candidates.push({
        vendorKeyId: k.id,
        keyName: k.name,
        apiKey: decryptSecret(k.keyCipher),
        apiBase: model.vendor.apiBase,
      });
    } catch {
      // 密钥解密失败（如 STORAGE_KEY_SECRET 变更）：跳过该 Key，走下一个
    }
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

// 选中 Key 后回写 lastUsedAt（fire-and-forget，不阻塞调用）
export function markKeyUsed(vendorKeyId: number) {
  db.vendorApiKey
    .update({ where: { id: vendorKeyId }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
}
