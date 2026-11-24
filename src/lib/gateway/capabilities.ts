// ─── P4 #17 能力协商 ───
// AiModel.capabilities（JSON 文本）声明该模型支持的参数白名单：
//   {"params":["temperature","max_tokens","stop","top_p","stream","tools",...]}
// 未配置（null/缺 params）= 全透传（向后兼容，老模型行为不变）；
// 配置后 chat 请求出现白名单外的参数 → 400 并指名参数（不静默降级）。

export interface ModelCapabilities {
  params?: string[];
  // modalities 预留（["text","image"]），本轮只做参数协商
  modalities?: string[];
}

// Prisma Json 字段 → 能力对象（兼容字符串存 JSON 的情况）
export function parseCapabilities(raw: unknown): ModelCapabilities | null {
  if (raw == null) return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as { params?: unknown; modalities?: unknown };
  return {
    params: Array.isArray(o.params) ? o.params.map(String) : undefined,
    modalities: Array.isArray(o.modalities) ? o.modalities.map(String) : undefined,
  };
}

// chat 核心参数：任何模型都必须支持，不参与白名单校验
const CHAT_CORE_PARAMS = new Set(["model", "messages", "stream"]);

// 校验请求参数是否全部在白名单内
// 返回 {ok:true} 或 {ok:false, unsupported:[...]}（全部指名，不只第一个）
export function checkChatParams(
  capabilities: unknown,
  body: Record<string, unknown>
): { ok: true } | { ok: false; unsupported: string[] } {
  const caps = parseCapabilities(capabilities);
  // 未配置 = 全透传（向后兼容）
  if (!caps || !caps.params || caps.params.length === 0) return { ok: true };
  const whitelist = new Set(caps.params);
  const unsupported: string[] = [];
  for (const key of Object.keys(body)) {
    if (CHAT_CORE_PARAMS.has(key)) continue;
    if (!whitelist.has(key)) unsupported.push(key);
  }
  if (unsupported.length === 0) return { ok: true };
  return { ok: false, unsupported };
}
