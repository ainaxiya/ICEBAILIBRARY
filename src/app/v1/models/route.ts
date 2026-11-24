import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authenticateV1 } from "@/lib/gateway/auth";
import { apiError } from "@/lib/gateway/errors";
import { vendorHasAvailableKey } from "@/lib/gateway/router";

export const dynamic = "force-dynamic";

// ─── GET /v1/models —— OpenAI 兼容模型列表 ───
// 鉴权同 /v1 其他端点（站内登录态 / 站外 Bearer sk- Key，见 gateway/auth）。
// 返回 status=online 的模型：id=模型名（调用时 model 参数填它），
// owned_by=厂商显示名，endpoint_type 决定调用哪个端点（chat→/v1/chat/completions，
// image/video→/v1/images/generations）。

// 统一错误体（P1 契约）：由 gateway/errors.ts 提供

export async function GET(req: NextRequest) {
  // ── 鉴权（站内登录态 / 站外 Bearer sk- Key） ──
  const auth = await authenticateV1(req);
  if (!auth.ok) {
    return apiError(auth.status, auth.message, "authentication_error", auth.code);
  }

  // S0-5：只返回可实际调用的模型 —— online + 厂商至少 1 把 active Key（健康渠道）
  // + 已配置定价（未定价模型调用时必然 404，不应对外暴露）
  // P2：Key 全部熔断中的厂商视为无健康渠道，模型从列表隐藏
  // （用户级模型权限白名单属 P3/P5 范围，当前语义：全部活跃会员可用全部在线模型）
  const models = await db.aiModel.findMany({
    where: {
      status: "online",
      vendor: { status: "online", keys: { some: { status: "active" } } },
      pricings: { some: {} },
    },
    include: { vendor: { include: { keys: { where: { status: "active" }, select: { id: true, status: true } } } } },
    orderBy: [{ vendorId: "asc" }, { id: "asc" }],
  });
  const healthy = models.filter((m) => vendorHasAvailableKey(m.vendor.keys));

  // 列表随 Key 健康/模型上下线变化，且响应与鉴权身份绑定：禁止任何中间层缓存
  return NextResponse.json(
    {
      object: "list",
      data: healthy.map((m) => ({
        id: m.name,
        object: "model",
        created: Math.floor(m.createdAt.getTime() / 1000),
        owned_by: m.vendor.name,
        endpoint_type: m.endpointType,
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
