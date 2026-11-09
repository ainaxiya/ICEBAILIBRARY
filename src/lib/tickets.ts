// v0.92 #4 工单问题类型（标题下拉必选项，前后台共用）
export const TICKET_TYPES = [
  "会员问题",
  "资金积分问题",
  "API使用问题",
  "发票问题",
  "其他问题",
] as const;

export type TicketType = (typeof TICKET_TYPES)[number];

export function isTicketType(v: unknown): v is TicketType {
  return typeof v === "string" && (TICKET_TYPES as readonly string[]).includes(v);
}
