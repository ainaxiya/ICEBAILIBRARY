import { channelSecret, getPayChannels, signStub } from "./config";
import type {
  CallbackVerifyResult,
  CreatePaymentResult,
  PaymentAdapter,
  PaymentOrderInfo,
  QueryStatusResult,
} from "./types";

// ─── 加密货币支付（本地 stub；配置收款地址 address / 网关 gatewayUrl） ───
// TODO 接真实网关：生成收款地址/发票 + 链上确认数回调验签
export const cryptoAdapter: PaymentAdapter = {
  channel: "crypto",
  displayName: "加密货币",

  async createPayment(order: PaymentOrderInfo, returnUrl: string): Promise<CreatePaymentResult> {
    const channels = await getPayChannels();
    const cfg = channels.crypto;
    if (!cfg?.enabled) return { ok: false, error: "加密货币通道未启用" };
    const eventId = `mock_evt_${order.orderNo}`;
    const fields = {
      orderNo: order.orderNo,
      eventId,
      amountCents: Number(order.amountCents),
    };
    return {
      ok: true,
      payUrl: `https://pay.mock.local/crypto/invoice?orderNo=${order.orderNo}`,
      params: {
        mock: true,
        channel: "crypto",
        address: cfg.address || "mock-usdt-trc20-address",
        gatewayUrl: cfg.gatewayUrl || "https://pay.mock.local/crypto",
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
    // 真实实现：校验网关回调签名与链上确认数（TODO 换真实密钥）
    const orderNo = String(body.orderNo || "");
    const eventId = String(body.eventId || "");
    const amountCents = Number(body.amountCents || 0);
    const sign = String(body.sign || "");
    const channels = await getPayChannels();
    const expect = signStub({ orderNo, eventId, amountCents }, channelSecret(channels.crypto));
    if (!orderNo || sign !== expect) return { ok: false, error: "加密货币回调验签失败" };
    return { ok: true, orderNo, eventId, amountCents };
  },

  async queryStatus(_orderNo: string): Promise<QueryStatusResult> {
    // TODO 查询发票/链上确认状态
    return { status: "pending" };
  },
};
