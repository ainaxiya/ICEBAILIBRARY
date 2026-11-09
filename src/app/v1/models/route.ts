import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authenticateV1 } from "@/lib/gateway/auth";

export const dynamic = "force-dynamic";

// ─── GET /v1/models —— OpenAI 兼容模型列表 ───
// 鉴权同 /v1 其他端点（站内登录态 / 站外 Bearer sk- Key，见 gateway/auth）。
// 返回 status=online 的模型：id=模型名（调用时 model 参数填它），
// owned_by=厂商显示名，endpoint_type 决定调用哪个端点（chat→/v1/chat/completions，
// image/video→/v1/images/generations）。

// OpenAI 风格错误体（与 /v1/chat/completions、/v1/images/generations 保持一致）
function apiError(status: number, message: string, type: string, code: string) {
  return NextResponse.json({ error: { message, type, code } }, { status });
}

export async function GET(req: NextRequest) {
  // ── 鉴权（站内登录态 / 站外 Bearer sk- Key） ──
  const auth = await authenticateV1(req);
  if (!auth.ok) {
    return apiError(auth.status, auth.message, "authentication_error", auth.code);
  }

  // S0-5：只返回可实际调用的模型 —— online + 厂商至少 1 把 active Key（健康渠道）
  // + 已配置定价（未定价模型调用时必然 404，不应对外暴露）
  // （用户级模型权限白名单属 P3/P5 范围，当前语义：全部活跃会员可用全部在线模型）
  const models = await db.aiModel.findMany({
    where: {
      status: "online",
      vendor: { status: "online", keys: { some: { status: "active" } } },
      pricings: { some: {} },
    },
    include: { vendor: true },
    orderBy: [{ vendorId: "asc" }, { id: "asc" }],
  });

  return NextResponse.json({
    object: "list",
    data: models.map((m) => ({
      id: m.name,
      object: "model",
      created: Math.floor(m.createdAt.getTime() / 1000),
      owned_by: m.vendor.name,
      endpoint_type: m.endpointType,
    })),
  });
}
