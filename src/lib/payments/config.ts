import crypto from "crypto";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, isEncrypted } from "@/lib/crypto";
import type { PayChannel } from "./types";

// ─── 支付通道配置（SiteSetting key="pay_channels"） ───
// 敏感字段（apiKey/key/secretKey/privateKey/webhookSecret/appSecret）用 AES-256-GCM 加密存储。

export interface ChannelConfig {
  enabled: boolean;
  // custom：gatewayUrl/appId/key；crypto：gatewayUrl/address/apiKey；
  // wechat：appId/mchId/apiKey；alipay：appId/privateKey/publicKey；stripe：secretKey/webhookSecret
  [field: string]: unknown;
}

export type PayChannelsConfig = Partial<Record<PayChannel, ChannelConfig>>;

const SENSITIVE_FIELDS = new Set(["apiKey", "key", "secretKey", "privateKey", "webhookSecret", "appSecret"]);

// 未配置时的默认（stub 全开，本地开发直接可用）
function defaultChannels(): PayChannelsConfig {
  return {
    wechat: { enabled: true, appId: "", mchId: "", apiKey: "" },
    alipay: { enabled: true, appId: "", privateKey: "", publicKey: "" },
    custom: { enabled: true, gatewayUrl: "", appId: "", key: "" },
    stripe: { enabled: true, secretKey: "", webhookSecret: "" },
    crypto: { enabled: true, gatewayUrl: "", address: "", apiKey: "" },
  };
}

export async function getPayChannels(): Promise<PayChannelsConfig> {
  const row = await db.siteSetting.findUnique({ where: { key: "pay_channels" } });
  if (!row) return defaultChannels();
  let parsed: PayChannelsConfig = {};
  try {
    parsed = JSON.parse(row.value) as PayChannelsConfig;
  } catch {
    return defaultChannels();
  }
  // 敏感字段解密
  for (const cfg of Object.values(parsed)) {
    if (!cfg) continue;
    for (const k of Object.keys(cfg)) {
      const v = cfg[k];
      if (SENSITIVE_FIELDS.has(k) && typeof v === "string" && isEncrypted(v)) {
        try {
          cfg[k] = decryptSecret(v);
        } catch {
          cfg[k] = "";
        }
      }
    }
  }
  return { ...defaultChannels(), ...parsed };
}

// 保存配置（敏感字段加密后落库；后台/运维配置入口用）
export async function savePayChannels(config: PayChannelsConfig): Promise<void> {
  const cloned: PayChannelsConfig = JSON.parse(JSON.stringify(config));
  for (const cfg of Object.values(cloned)) {
    if (!cfg) continue;
    for (const k of Object.keys(cfg)) {
      const v = cfg[k];
      if (SENSITIVE_FIELDS.has(k) && typeof v === "string" && v && !isEncrypted(v)) {
        cfg[k] = encryptSecret(v);
      }
    }
  }
  await db.siteSetting.upsert({
    where: { key: "pay_channels" },
    update: { value: JSON.stringify(cloned) },
    create: { key: "pay_channels", value: JSON.stringify(cloned) },
  });
}

// 签名辅助（stub 统一用 sha256；真实网关各通道算法不同，接入时替换）
export function signStub(fields: Record<string, string | number>, secret: string): string {
  const base = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("&");
  return crypto.createHash("sha256").update(`${base}&key=${secret || "mock-dev-secret"}`, "utf8").digest("hex");
}

// 通道签名密钥（未配置时回退 mock 密钥；TODO 真实密钥）
export function channelSecret(cfg: ChannelConfig | undefined): string {
  const s = cfg?.apiKey ?? cfg?.key ?? cfg?.secretKey ?? cfg?.webhookSecret;
  return typeof s === "string" && s ? s : "mock-dev-secret";
}
