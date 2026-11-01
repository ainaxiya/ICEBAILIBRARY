// ─── P2 支付适配器接口（本地开发全部 stub，不接真实网关） ───
// 五个通道实现：wechat / alipay / custom / stripe / crypto。
// createPayment 返回模拟支付页参数；verifyCallback 保留真实签名校验结构（TODO 真实密钥）。

export type PayChannel = "wechat" | "alipay" | "custom" | "stripe" | "crypto";

export interface PaymentOrderInfo {
  orderNo: string;
  // 应付金额（人民币分）
  amountCents: bigint;
  // 商品描述（如 "积分包 p50"）
  subject: string;
  userId: number;
}

export interface CreatePaymentResult {
  ok: boolean;
  // 模拟收银台地址（stub）
  payUrl?: string;
  // 模拟支付页参数（含 notifyPayload：开发模式可直接 POST 回调端点完成模拟支付）
  params?: Record<string, unknown>;
  error?: string;
}

export interface CallbackVerifyResult {
  ok: boolean;
  orderNo?: string;
  // 支付方事件号（回调幂等键）
  eventId?: string;
  amountCents?: number;
  error?: string;
}

export interface QueryStatusResult {
  // 本地订单语义对齐 PayOrder.status
  status: "pending" | "paid" | "failed" | "closed" | "unknown";
  eventId?: string;
}

export interface PaymentAdapter {
  channel: PayChannel;
  displayName: string;
  createPayment(order: PaymentOrderInfo, returnUrl: string): Promise<CreatePaymentResult>;
  // body 为已解析的回调报文（各通道字段/签名结构不同）
  verifyCallback(req: Request, body: Record<string, unknown>): Promise<CallbackVerifyResult>;
  queryStatus(orderNo: string): Promise<QueryStatusResult>;
}
