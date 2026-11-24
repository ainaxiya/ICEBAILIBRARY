"use client";

import { useState } from "react";

// ─── 模型厂商 LOGO：simpleicons CDN + 首字母徽章兜底 ───
// 厂商名（模型厂商，非上游供应商）→ simpleicons slug；无图标的厂商显示首字圆形徽章
const SLUG: Record<string, string> = {
  OpenAI: "openai",
  Anthropic: "anthropic",
  Google: "google",
  GoogleDeepMind: "googlegemini",
  DeepSeek: "deepseek",
  xAI: "xai",
  Qwen: "qwen",
  AlibabaCloud: "alibabacloud",
  Alibaba: "alibabacloud",
  ZhipuAI: "zhipuai",
  Zhipu: "zhipuai",
  MoonshotAI: "moonshotai",
  ByteDance: "bytedance",
  ByteDanceSeed: "bytedance",
  MiniMax: "minimax",
  Xiaomi: "xiaomi",
  Midjourney: "midjourney",
  Meta: "meta",
  StabilityAI: "stabilityai",
  BlackForestLabs: "blackforestlabs",
  Kuaishou: "kuaishou",
  Baidu: "baidu",
  Tencent: "tencent",
  Runway: "runwayml",
  RunwayML: "runwayml",
  Pika: "pika",
  Luma: "lumalabs",
  LumaAI: "lumalabs",
  ElevenLabs: "elevenlabs",
  Suno: "suno",
  MistralAI: "mistralai",
  Cohere: "cohere",
  Perplexity: "perplexity",
  HuggingFace: "huggingface",
  Nvidia: "nvidia",
  Microsoft: "microsoft",
  Amazon: "amazonwebservices",
  Baichuan: "baichuan",
  SenseTime: "sensetime",
  iFlytek: "iflytek",
  Kunlun: "kunlun",
  StepFun: "stepfun",
  Netease: "netease",
  Vidu: "vidu",
  Shengshu: "shengshu",
};

// 首字徽章配色（按名称 hash 取色）
const BADGE_COLORS = [
  "bg-sky-500/20 text-sky-300",
  "bg-violet-500/20 text-violet-300",
  "bg-emerald-500/20 text-emerald-300",
  "bg-amber-500/20 text-amber-300",
  "bg-rose-500/20 text-rose-300",
  "bg-cyan-500/20 text-cyan-300",
  "bg-fuchsia-500/20 text-fuchsia-300",
];

export default function VendorLogo({
  vendor,
  size = 20,
  className = "",
}: {
  vendor: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const slug = SLUG[vendor];
  const color = BADGE_COLORS[(vendor.charCodeAt(0) + vendor.length) % BADGE_COLORS.length];

  if (!slug || failed) {
    return (
      <span
        title={vendor}
        style={{ width: size, height: size, fontSize: Math.max(12, size * 0.5) }}
        className={`inline-grid shrink-0 place-items-center rounded-full font-bold ${color} ${className}`}
      >
        {vendor.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://cdn.simpleicons.org/${slug}/white`}
      alt={vendor}
      title={vendor}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`inline-block shrink-0 opacity-90 ${className}`}
    />
  );
}
