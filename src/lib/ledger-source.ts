import { db } from "@/lib/db";

// ─── 积分明细「来源」简要中文 ───
// refType=request → 关联 usage_record 显示「AI 对话 · 模型名」；
// refType=credit_grant → 关联 credit_grant 显示发放类型（充值/订阅/赠送/试用）；
// refType=order → 充值订单；refType=admin → 管理员调账（备注）。

const ENDPOINT_LABEL: Record<string, string> = {
  chat: "AI 对话",
  image: "AI 生图",
  video: "AI 视频",
  audio: "AI 音频",
};

const GRANT_LABEL: Record<string, string> = {
  topup: "充值到账",
  subscription: "订阅发放",
  gift: "赠送到账",
  trial: "试用到账",
};

export interface LedgerSourceRow {
  refType: string | null;
  refId: string | null;
}

// 批量生成与 rows 对齐的来源文案
export async function describeLedgerSources(rows: LedgerSourceRow[]): Promise<string[]> {
  const requestIds = [...new Set(rows.filter((r) => r.refType === "request" && r.refId).map((r) => r.refId as string))];
  const grantIds = [
    ...new Set(
      rows
        .filter((r) => r.refType === "credit_grant" && r.refId && /^\d+$/.test(r.refId))
        .map((r) => parseInt(r.refId as string))
    ),
  ];

  const [usages, grants] = await Promise.all([
    requestIds.length > 0
      ? db.usageRecord.findMany({
          where: { requestId: { in: requestIds } },
          select: { requestId: true, modelSnapshot: true, endpointType: true },
        })
      : Promise.resolve([]),
    grantIds.length > 0
      ? db.creditGrant.findMany({ where: { id: { in: grantIds } }, select: { id: true, grantType: true } })
      : Promise.resolve([]),
  ]);

  const usageByReq = new Map(usages.map((u) => [u.requestId, u]));
  const grantById = new Map(grants.map((g) => [g.id, g]));

  return rows.map((r) => {
    if (!r.refType) return "—";
    if (r.refType === "request") {
      const u = r.refId ? usageByReq.get(r.refId) : undefined;
      if (!u) return "AI 请求";
      const label = ENDPOINT_LABEL[u.endpointType] || "AI 请求";
      return u.modelSnapshot ? `${label} · ${u.modelSnapshot}` : label;
    }
    if (r.refType === "credit_grant") {
      const g = r.refId && /^\d+$/.test(r.refId) ? grantById.get(parseInt(r.refId)) : undefined;
      return g ? GRANT_LABEL[g.grantType] || "积分发放" : "积分发放";
    }
    if (r.refType === "order") return "充值订单";
    if (r.refType === "admin") {
      const note = (r.refId || "").trim();
      return note ? `管理员调账：${note.length > 24 ? note.slice(0, 24) + "…" : note}` : "管理员调账";
    }
    return r.refType;
  });
}
