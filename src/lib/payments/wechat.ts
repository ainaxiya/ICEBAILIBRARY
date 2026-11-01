import { channelSecret, getPayChannels, signStub } from "./config";
import type {
  CallbackVerifyResult,
  CreatePaymentResult,
  PaymentAdapter,
  PaymentOrderInfo,
  QueryStatusResult,
} from "./types";

// ─── 微信支付（本地 stub；TODO 接真实网关：Native 下单 + 回调 RSA/MD5 验签） ───
export const wechatAdapter: PaymentAdapter = {
  channel: "wechat",
  displayName: "微信支付",

  async createPayment(order: PaymentOrderInfo, returnUrl: string): Promise<CreatePaymentResult> {
    const channels = await getPayChannels();
    const cfg = channels.wechat;
    if (!cfg?.enabled) return { ok: false, error: "微信支付通道未启用" };
    const eventId = `mock_evt_${order.orderNo}`;
    const fields = {
      orderNo: order.orderNo,
      eventId,
      amountCents: Number(order.amountCents),
    };
    return {
      ok: true,
      payUrl: `https://pay.mock.local/wechat/checkout?orderNo=${order.orderNo}`,
      params: {
        mock: true,
        channel: "wechat",
        appId: cfg.appId || "wx-mock-appid",
        mchId: cfg.mchId || "mock-mch",
        orderNo: order.orderNo,
        amountCents: Number(order.amountCents),
        subject: order.subject,
        returnUrl,
        payTip: "本地开发模式，模拟支付参数（未接真实网关）",
        // 开发模式可直接 POST /api/member/pay/notify/wechat 完成模拟支付
        notifyPayload: { ...fields, sign: signStub(fields, channelSecret(cfg)) },
      },
    };
  },

  async verifyCallback(_req: Request, body: Record<string, unknown>): Promise<CallbackVerifyResult> {
    // 真实实现：验证微信回调签名（MD5/RSA，TODO 换真实密钥与验签）
    const orderNo = String(body.orderNo || "");
    const eventId = String(body.eventId || "");
    const amountCents = Number(body.amountCents || 0);
    const sign = String(body.sign || "");
    const channels = await getPayChannels();
    const expect = signStub({ orderNo, eventId, amountCents }, channelSecret(channels.wechat));
    if (!orderNo || sign !== expect) return { ok: false, error: "微信回调验签失败" };
    return { ok: true, orderNo, eventId, amountCents };
  },

  async queryStatus(_orderNo: string): Promise<QueryStatusResult> {
    // TODO 真实查询微信订单状态
    return { status: "pending" };
  },
};
