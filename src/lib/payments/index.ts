import type { PayChannel, PaymentAdapter } from "./types";
import { wechatAdapter } from "./wechat";
import { alipayAdapter } from "./alipay";
import { customAdapter } from "./custom";
import { stripeAdapter } from "./stripe";
import { cryptoAdapter } from "./crypto";

export type { PayChannel, PaymentAdapter, PaymentOrderInfo, CreatePaymentResult, CallbackVerifyResult, QueryStatusResult } from "./types";
export { getPayChannels, savePayChannels } from "./config";

const ADAPTERS: Record<PayChannel, PaymentAdapter> = {
  wechat: wechatAdapter,
  alipay: alipayAdapter,
  custom: customAdapter,
  stripe: stripeAdapter,
  crypto: cryptoAdapter,
};

// 通道列表（充值页展示顺序）
export const PAY_CHANNEL_LIST: { channel: PayChannel; name: string }[] = [
  { channel: "wechat", name: "微信支付" },
  { channel: "alipay", name: "支付宝" },
  { channel: "custom", name: "自定义网关" },
  { channel: "stripe", name: "Stripe" },
  { channel: "crypto", name: "加密货币" },
];

export function isPayChannel(v: string): v is PayChannel {
  return v in ADAPTERS;
}

export function getAdapter(channel: string): PaymentAdapter | null {
  return isPayChannel(channel) ? ADAPTERS[channel] : null;
}
