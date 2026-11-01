import { channelSecret, getPayChannels, signStub } from "./config";
import type {
  CallbackVerifyResult,
  CreatePaymentResult,
  PaymentAdapter,
  PaymentOrderInfo,
  QueryStatusResult,
} from "./types";

// ─── Stripe（本地 stub；TODO 接真实网关：Checkout Session + webhook 签名校验） ───
export const stripeAdapter: PaymentAdapter = {
  channel: "stripe",
  displayName: "Stripe",

  async createPayment(order: PaymentOrderInfo, returnUrl: string): Promise<CreatePaymentResult> {
    const channels = await getPayChannels();
    const cfg = channels.stripe;
    if (!cfg?.enabled) return { ok: false, error: "Stripe 通道未启用" };
    const eventId = `mock_evt_${order.orderNo}`;
    const fields = {
      orderNo: order.orderNo,
      eventId,
      amountCents: Number(order.amountCents),
    };
    return {
      ok: true,
      payUrl: `https://pay.mock.local/stripe/checkout?orderNo=${order.orderNo}`,
      params: {
        mock: true,
        channel: "stripe",
        orderNo: order.orderNo,
        amountCents: Number(order.amountCents),
        currency: "cny",
        subject: order.subject,
        returnUrl,
        payTip: "本地开发模式，模拟支付参数（未接真实网关）",
        notifyPayload: { ...fields, sign: signStub(fields, channelSecret(cfg)) },
      },
    };
  },

  async verifyCallback(_req: Request, body: Record<string, unknown>): Promise<CallbackVerifyResult> {
    // 真实实现：Stripe-Signature HMAC-SHA256 验签（webhookSecret，TODO 换真实密钥）
    const orderNo = String(body.orderNo || "");
    const eventId = String(body.eventId || "");
    const amountCents = Number(body.amountCents || 0);
    const sign = String(body.sign || "");
    const channels = await getPayChannels();
    const expect = signStub({ orderNo, eventId, amountCents }, channelSecret(channels.stripe));
    if (!orderNo || sign !== expect) return { ok: false, error: "Stripe webhook 验签失败" };
    return { ok: true, orderNo, eventId, amountCents };
  },

  async queryStatus(_orderNo: string): Promise<QueryStatusResult> {
    // TODO 查询 Stripe Checkout Session / PaymentIntent 状态
    return { status: "pending" };
  },
};
