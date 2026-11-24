import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import {
  latestPricing,
  videoDisplayPricing,
  perMillionMemberCredits,
  perUnitMemberCredits,
  videoPerSecondMemberCredits,
} from "@/lib/gateway/pricing";
import {
  API_DOCS_BASE_URL_SETTING_KEY,
  DEFAULT_API_DOCS_BASE_URL,
} from "@/lib/api-docs-default";

export const dynamic = "force-dynamic";

// ─── v0.116 会员中心模型库：模型名称 / 上下文·时长 / 输入价格 / 输出价格 / 供应商 LOGO ───
// 只返回 status=online 的模型（后台已上线），功能 = endpointType + 已启用端点路径

const ENDPOINT_LABEL: Record<string, string> = {
  chat_completions: "对话补全",
  image_generations: "图像生成",
  video_generations: "视频生成",
  audio_generations: "音频生成",
  embeddings: "向量嵌入",
};

const TYPE_LABEL: Record<string, string> = {
  chat: "对话",
  image: "图像",
  video: "视频",
  audio: "音频",
};

// 模型名 → 原厂推断（供应商 LOGO 用）
function inferBrand(name: string): string | null {
  const n = name.toLowerCase();
  if (/^(gpt|o[13456]?(-|\b)|chatgpt|dall[-.]?e|whisper|tts|sora|codex|davinci|text-embedding)/.test(n)) return "OpenAI";
  if (n.startsWith("claude")) return "Anthropic";
  if (/(gemini|nano[- ]banana|imagen|veo|gemma)/.test(n)) return "Google";
  if (n.includes("deepseek")) return "DeepSeek";
  if (n.startsWith("grok")) return "xAI";
  if (/(qwen|qwq|qvq|wanx?)/.test(n)) return "Qwen";
  if (/(glm|chatglm|cogview|cogvideo)/.test(n)) return "ZhipuAI";
  if (/(kimi|moonshot)/.test(n)) return "MoonshotAI";
  if (/(doubao|seedance|seedream|seed-|seededit)/.test(n)) return "ByteDance";
  if (/(minimax|hailuo|abab)/.test(n)) return "MiniMax";
  if (/(midjourney|mj_)/.test(n)) return "Midjourney";
  if (/flux/.test(n)) return "BlackForestLabs";
  if (/(stable|sdxl|sd3)/.test(n)) return "StabilityAI";
  if (/(kling|keling)/.test(n)) return "Kuaishou";
  if (/(ernie|wenxin)/.test(n)) return "Baidu";
  if (n.includes("hunyuan")) return "Tencent";
  if (n.includes("llama")) return "Meta";
  if (n.includes("vidu")) return "Vidu";
  if (/(runway|gen-[34])/.test(n)) return "RunwayML";
  if (n.includes("pika")) return "Pika";
  if (/(luma|dream[- ]machine|ray[- ]?2)/.test(n)) return "LumaAI";
  if (n.startsWith("suno")) return "Suno";
  if (n.includes("mistral")) return "MistralAI";
  if (/(step|stepfun)/.test(n)) return "StepFun";
  if (n.includes("mimo")) return "Xiaomi";
  return null;
}

// 从 advancedConfig 提取上下文/时长展示
// 视频参数结构（上游）：{"model_spec":{"constraints":{"durations":["4s",...,"30s"],"resolutions":[...]}}}
function extractCtxLabel(name: string, endpointType: string, advancedConfig: string | null): string | null {
  let cfg: Record<string, unknown> | null = null;
  if (advancedConfig) {
    try {
      const v = JSON.parse(advancedConfig);
      if (v && typeof v === "object") cfg = v as Record<string, unknown>;
    } catch {
      /* 忽略非 JSON */
    }
  }
  if (cfg) {
    // 上游视频参数：model_spec.constraints.durations
    const spec = cfg.model_spec as Record<string, unknown> | undefined;
    const cons = spec?.constraints as Record<string, unknown> | undefined;
    const durs = cons?.durations;
    if (Array.isArray(durs) && durs.length) return summarizeDurations(durs);
    const cw = cfg.contextWindow ?? cfg.duration ?? cfg.duration_options ?? cfg.videoDuration;
    if (typeof cw === "string" && cw) return cw;
    if (typeof cw === "number" && cw > 0) return `${cw}s`;
    if (Array.isArray(cw) && cw.length) return summarizeDurations(cw);
    // 视频参数对象里找 duration 字段
    for (const k of ["duration", "durationSec", "videoLength", "length"]) {
      const v = cfg[k];
      if (typeof v === "string" && v) return v;
      if (typeof v === "number" && v > 0) return `${v}s`;
      if (Array.isArray(v) && v.length) return summarizeDurations(v);
    }
  }
  // 按模型类型兜底
  if (endpointType === "image") return "按张计费";
  return null;
}

// 时长数组摘要：["4s",..."30s"] → "4-30s"；少量直接列举
function summarizeDurations(arr: unknown[]): string {
  const nums = arr
    .map((x) => (typeof x === "number" ? x : parseFloat(String(x))))
    .filter((n) => Number.isFinite(n));
  if (nums.length >= 4) return `${nums[0]}-${nums[nums.length - 1]}s`;
  if (nums.length) return nums.map((n) => `${n}s`).join(" / ");
  return arr.slice(0, 3).map(String).join(" / ");
}

// 定价展示（积分，整数化；token=积分/1M、video_second=积分/秒、image=积分/张、request=积分/次）
// 前台只允许出现会员价：成本价/上游原价一律不下发（成本价仅供管理后台核算）
function priceCredits(pricing: NonNullable<Awaited<ReturnType<typeof latestPricing>>>) {
  // 视频统一秒价：只认通用行；留空 = 未定价（不按最低 1 分兜底）
  if (pricing.unit === "video_second") {
    const perSecond = videoPerSecondMemberCredits(pricing);
    if (perSecond == null) return null;
    return { unit: pricing.unit, memberInput: perSecond, memberOutput: null };
  }
  const isToken = pricing.unit === "token";
  const input = isToken ? perMillionMemberCredits(pricing, "input") : perUnitMemberCredits(pricing, "input");
  const output = isToken ? perMillionMemberCredits(pricing, "output") : perUnitMemberCredits(pricing, "output");
  return {
    unit: pricing.unit,
    memberInput: Math.ceil(input),
    // 媒体模型（按张/秒/次）只有单一计价 → 输出侧置 null，前端显示 —
    memberOutput: isToken ? Math.ceil(output) : null,
  };
}

// 能力矩阵（P4 落库的 capabilities JSON）→ 只保留字符串数组，异常结构一律视为空
function normalizeCapabilities(raw: unknown): { params: string[]; modalities: string[] } {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const pick = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 24) : [];
  return { params: pick(obj?.params), modalities: pick(obj?.modalities) };
}

export async function GET() {
  const currentUser = await getCurrentUser();
  if (!currentUser) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // 近 7 天可用性：按模型聚合调用数与成功数（仅统计有 modelId 的网关调用）
  const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const baseUrlSetting = db.siteSetting.findUnique({
    where: { key: API_DOCS_BASE_URL_SETTING_KEY },
    select: { value: true },
  });
  const statsQuery = db.$queryRaw<{ id: bigint; calls: number; success: number }[]>`
    SELECT "modelId" AS id,
           COUNT(*)::int AS calls,
           COUNT(*) FILTER (WHERE status = 'success')::int AS success
    FROM usage_record
    WHERE "createdAt" >= ${since7d} AND "modelId" IS NOT NULL
    GROUP BY 1
  `;

  const [vendors, models, baseUrlRow, statRows] = await Promise.all([
    db.aiVendor.findMany({
      where: { status: "online" },
      orderBy: { id: "asc" },
      select: { id: true, name: true, slug: true },
    }),
    db.aiModel.findMany({
      where: { status: "online", vendor: { status: "online" } },
      orderBy: [{ vendorId: "asc" }, { id: "asc" }],
      select: {
        id: true,
        vendorId: true,
        name: true,
        displayName: true,
        endpointType: true,
        remark: true,
        advancedConfig: true,
        capabilities: true,
        endpoints: { where: { enabled: true }, select: { path: true } },
        pricings: { orderBy: { effectiveAt: "desc" } },
      },
    }),
    baseUrlSetting,
    statsQuery,
  ]);

  const baseUrl = (baseUrlRow?.value || "").trim() || DEFAULT_API_DOCS_BASE_URL;
  const statMap = new Map(statRows.map((r) => [String(r.id), r]));

  const byVendor = vendors.map((v) => {
    const list = models
      .filter((m) => m.vendorId === v.id)
      .map((m) => {
        const pricing = m.endpointType === "video" ? videoDisplayPricing(m) : latestPricing(m);
        const p = pricing ? priceCredits(pricing) : null;
        const s = statMap.get(String(m.id));
        return {
          id: m.id,
          name: m.name,
          displayName: m.displayName,
          endpointType: m.endpointType,
          type: TYPE_LABEL[m.endpointType] || m.endpointType,
          features: m.endpoints.map((e) => ENDPOINT_LABEL[e.path] || e.path),
          remark: m.remark,
          capabilities: normalizeCapabilities(m.capabilities),
          vendorLabel: inferBrand(m.name),
          ctxLabel: extractCtxLabel(m.name, m.endpointType, m.advancedConfig),
          pricing: p,
          // 近 7 天可用性（站内 + API 调用合并）：无调用时为 null，前端不估算
          stats: s ? { calls: Number(s.calls), success: Number(s.success) } : null,
        };
      });
    return { id: v.id, name: v.name, slug: v.slug, count: list.length, models: list };
  });

  return NextResponse.json({
    total: models.length,
    vendorCount: byVendor.length,
    baseUrl,
    statsDays: 7,
    vendors: byVendor,
  });
}
