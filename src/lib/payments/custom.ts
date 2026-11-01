import { channelSecret, getPayChannels, signStub } from "./config";
import type {
  CallbackVerifyResult,
  CreatePaymentResult,
  PaymentAdapter,
  PaymentOrderInfo,
  QueryStatusResult,
} from "./types";

// ─── 自定义三方 / 易支付类网关（本地 stub；配置 gatewayUrl/appId/key） ───
// TODO 接真实网关：按对方文档拼跳转参数 + md5 签名校验
export const customAdapter: PaymentAdapter = {
  channel: "custom",
  displayName: "自定义网关",

  async createPayment(order: PaymentOrderInfo, returnUrl: string): Promise<CreatePaymentResult> {
    const channels = await getPayChannels();
    const cfg = channels.custom;
    if (!cfg?.enabled) return { ok: false, error: "自定义支付通道未启用" };
    const eventId = `mock_evt_${order.orderNo}`;
    const fields = {
      orderNo: order.orderNo,
      eventId,
      amountCents: Number(order.amountCents),
    };
    const gateway = String(cfg.gatewayUrl || "https://pay.mock.local/custom");
    return {
      ok: true,
      payUrl: `${gateway.replace(/\/+$/, "")}/pay?orderNo=${order.orderNo}`,
      params: {
        mock: true,
        channel: "custom",
        gatewayUrl: gateway,
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
    // 真实实现：按三方/易支付文档做 md5/HMAC 验签（TODO 换真实密钥）
    const orderNo = String(body.orderNo || "");
    const eventId = String(body.eventId || "");
    const amountCents = Number(body.amountCents || 0);
    const sign = String(body.sign || "");
    const channels = await getPayChannels();
    const expect = signStub({ orderNo, eventId, amountCents }, channelSecret(channels.custom));
    if (!orderNo || sign !== expect) return { ok: false, error: "自定义网关回调验签失败" };
    return { ok: true, orderNo, eventId, amountCents };
  },

  async queryStatus(_orderNo: string): Promise<QueryStatusResult> {
    // TODO 调 gatewayUrl 订单查询接口
    return { status: "pending" };
  },
};
