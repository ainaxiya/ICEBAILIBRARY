import type { AiModel, AiVendor, ModelEndpoint, ModelPricing } from "@prisma/client";
import { decryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { latestPricing } from "./pricing";

// ─── P1 聚合网关：Key 路由（方案 6.1 第 5 步） ───
// 按模型名查 online 模型 + 启用绑定（Key 须 active），
// priority 升序（小值优先），同 priority 组内按 weight 加权随机排序；
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

// 加权随机排序（不放回抽样：权重越大越靠前的概率越高）
function weightedOrder<T extends { weight: number }>(items: T[]): T[] {
  const rest = [...items];
  const out: T[] = [];
  while (rest.length > 0) {
    const total = rest.reduce((s, x) => s + Math.max(1, x.weight), 0);
    let r = Math.random() * total;
    let idx = rest.length - 1;
    for (let i = 0; i < rest.length; i++) {
      r -= Math.max(1, rest[i].weight);
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    out.push(rest[idx]);
    rest.splice(idx, 1);
  }
  return out;
}

// 解析模型路由：null = 模型不存在或已下线
export async function resolveRoute(modelName: string): Promise<RouteContext | null> {
  const model = await db.aiModel.findFirst({
    where: { name: modelName, status: "online" },
    include: {
      vendor: true,
      endpoints: true,
      pricings: true,
      bindings: {
        where: { enabled: true },
        include: { apiKey: true },
      },
    },
  });
  if (!model) return null;

  // priority 升序分组；同 priority 按 weight 加权随机
  const groups = new Map<number, typeof model.bindings>();
  for (const b of model.bindings) {
    if (!b.apiKey || b.apiKey.status !== "active") continue;
    const g = groups.get(b.priority) ?? [];
    g.push(b);
    groups.set(b.priority, g);
  }
  const ordered = [...groups.keys()]
    .sort((a, b) => a - b)
    .flatMap((p) => weightedOrder(groups.get(p)!));

  const candidates: KeyCandidate[] = [];
  for (const b of ordered) {
    try {
      candidates.push({
        vendorKeyId: b.apiKey.id,
        keyName: b.apiKey.name,
        apiKey: decryptSecret(b.apiKey.keyCipher),
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
