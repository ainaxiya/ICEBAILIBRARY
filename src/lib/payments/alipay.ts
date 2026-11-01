import { channelSecret, getPayChannels, signStub } from "./config";
import type {
  CallbackVerifyResult,
  CreatePaymentResult,
  PaymentAdapter,
  PaymentOrderInfo,
  QueryStatusResult,
} from "./types";

// ─── 支付宝（本地 stub；TODO 接真实网关：alipay.trade.page.pay + 回调 RSA2 验签） ───
export const alipayAdapter: PaymentAdapter = {
  channel: "alipay",
  displayName: "支付宝",

  async createPayment(order: PaymentOrderInfo, returnUrl: string): Promise<CreatePaymentResult> {
    const channels = await getPayChannels();
    const cfg = channels.alipay;
    if (!cfg?.enabled) return { ok: false, error: "支付宝通道未启用" };
    const eventId = `mock_evt_${order.orderNo}`;
    const fields = {
      orderNo: order.orderNo,
      eventId,
      amountCents: Number(order.amountCents),
    };
    return {
      ok: true,
      payUrl: `https://pay.mock.local/alipay/checkout?orderNo=${order.orderNo}`,
      params: {
        mock: true,
        channel: "alipay",
        appId: cfg.appId || "mock-appid",
        orderNo: order.orderNo,
        amountCents: Number(order.amountCents),
        subject: order.subject,
        returnUrl,
        payTip: "本地开发模式，模拟支付参数（未接真实网关）",
        notifyPayload: { ...fields, sign: signStub(fields, channelSecret(cfg)) },
      },
    };
  },

  async verifyCallback(_req: Request, body: Record<string, unknown>): Promise<CallbackVerifyResult> {
    // 真实实现：支付宝 RSA2 公钥验签（TODO 换真实公钥）
    const orderNo = String(body.orderNo || "");
    const eventId = String(body.eventId || "");
    const amountCents = Number(body.amountCents || 0);
    const sign = String(body.sign || "");
    const channels = await getPayChannels();
    const expect = signStub({ orderNo, eventId, amountCents }, channelSecret(channels.alipay));
    if (!orderNo || sign !== expect) return { ok: false, error: "支付宝回调验签失败" };
    return { ok: true, orderNo, eventId, amountCents };
  },

  async queryStatus(_orderNo: string): Promise<QueryStatusResult> {
    // TODO 真实查询支付宝交易状态
    return { status: "pending" };
  },
};
