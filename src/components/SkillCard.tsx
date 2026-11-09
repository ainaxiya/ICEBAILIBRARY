import Link from "next/link";
import type { CSSProperties } from "react";
import { skillHref } from "@/lib/skill-link";
import type { Locale } from "@/lib/i18n";

// AI 技能卡片（首页「精选技能展示」与技能列表页共用）
// v0.93 新风格：skill-glow 边缘发光（默认常驻，hover 光更大 + 标题变色发光）+ 精选徽章 + 查看技能按钮

type SkillCardData = {
  id: number;
  slug: string;
  name: string;
  summary: string;
  tags: string[];
  viewCount: number;
  copyCount: number;
  featured?: boolean;
  category: { slug: string; name: string; nameEn: string; icon?: string | null };
};

const THEME: Record<string, { badge: string; btn: string; glow: string }> = {
  bc: { badge: "bg-sky-500/10 text-sky-300", btn: "from-sky-500 to-blue-500 shadow-sky-600/25", glow: "14 165 235" },
  wr: { badge: "bg-orange-500/10 text-orange-300", btn: "from-orange-500 to-amber-500 shadow-orange-600/25", glow: "249 115 22" },
  de: { badge: "bg-rose-500/10 text-rose-300", btn: "from-rose-500 to-pink-500 shadow-rose-600/25", glow: "244 63 94" },
  da: { badge: "bg-cyan-500/10 text-cyan-300", btn: "from-cyan-500 to-sky-500 shadow-cyan-600/25", glow: "6 182 212" },
  au: { badge: "bg-violet-500/10 text-violet-300", btn: "from-violet-500 to-purple-500 shadow-violet-600/25", glow: "139 92 246" },
  ma: { badge: "bg-amber-500/10 text-amber-300", btn: "from-amber-500 to-orange-500 shadow-amber-600/25", glow: "245 158 11" },
  os: { badge: "bg-red-500/10 text-red-300", btn: "from-red-500 to-rose-500 shadow-red-600/25", glow: "239 68 68" },
  re: { badge: "bg-teal-500/10 text-teal-300", btn: "from-teal-500 to-emerald-500 shadow-teal-600/25", glow: "20 184 166" },
  pr: { badge: "bg-fuchsia-500/10 text-fuchsia-300", btn: "from-fuchsia-500 to-purple-500 shadow-fuchsia-600/25", glow: "217 70 239" },
};
const DEFAULT_THEME = { badge: "bg-emerald-500/10 text-emerald-300", btn: "from-emerald-500 to-teal-500 shadow-emerald-600/25", glow: "56 189 248" };

// 按分类 slug 编码 / 分类名关键词匹配（本地 slug 为英文名，生产为两位编码，均兼容；未知分类回退默认）
const NAME_THEME: [RegExp, keyof typeof THEME][] = [
  [/智能体|agent/i, "au"],
  [/写作|writing|办公/i, "wr"],
  [/设计|design|创意/i, "de"],
  [/数据|data|分析/i, "da"],
  [/营销|marketing|运营/i, "ma"],
  [/安全|security/i, "os"],
  [/科研|research|学术/i, "re"],
  [/提示词|prompt/i, "pr"],
  [/编程|coding|program|开发/i, "bc"],
];
function themeFor(slug: string, name = "") {
  const s = (slug || "").toLowerCase();
  if (THEME[s]) return THEME[s];
  const all = `${slug} ${name}`;
  for (const [re, key] of NAME_THEME) if (re.test(all)) return THEME[key];
  return DEFAULT_THEME;
}

export default function SkillCard({
  s,
  locale = "zh",
}: {
  s: SkillCardData;
  locale?: Locale;
}) {
  const th = themeFor(s.category.slug, s.category.name);
  return (
    <Link
      href={skillHref(s.slug, s.id)}
      style={{ "--glow-rgb": th.glow } as CSSProperties}
      className="skill-glow group relative flex flex-col rounded-2xl border bg-gradient-to-b from-zinc-900/90 to-zinc-950/90 p-4 transition hover:-translate-y-0.5"
    >
      {/* 精选徽标：卡片右上角，深红偏橙底白字 */}
      {s.featured && (
        <span className="absolute right-3 top-3 rounded bg-[#bf360c] px-1.5 py-0.5 text-[10px] font-bold text-white shadow-[0_2px_10px_rgba(191,54,12,0.45)]">★ 精选</span>
      )}
      {/* 头部：标题 + slug/分类徽章 */}
      <div className="mb-3">
        <h3 className={`skill-title line-clamp-2 font-semibold leading-snug text-zinc-50 ${s.featured ? "pr-12" : ""}`} title={s.name}>
          {s.name}
        </h3>
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
          <span className="truncate text-zinc-500">{s.slug}</span>
          <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${th.badge}`}>
            {s.category.icon && <span className="mr-0.5">{s.category.icon}</span>}
            {locale === "zh" ? s.category.name : s.category.nameEn}
          </span>
        </div>
      </div>

      {/* 说明（触发语） */}
      <div className="mb-2.5 rounded-xl bg-zinc-800/40 p-2.5">
        <p className="mb-1 text-[11px] font-medium text-zinc-400">📄 {locale === "zh" ? "说明" : "About"}</p>
        <p className="line-clamp-2 text-xs leading-relaxed text-zinc-300">{s.summary}</p>
      </div>

      {/* 标签 */}
      {s.tags.length > 0 && (
        <div className="mb-2.5">
          <p className="mb-1.5 text-[11px] font-medium text-zinc-400">🏷 {locale === "zh" ? "关联标签" : "Tags"}</p>
          <div className="flex flex-wrap gap-1.5">
            {s.tags.slice(0, 4).map((tag) => (
              <span key={tag} className={`rounded-md px-2 py-0.5 text-[10px] ${th.badge}`}>{tag}</span>
            ))}
          </div>
        </div>
      )}

      {/* 统计行（底部对齐） */}
      <div className="mt-auto flex items-center justify-between pt-1 text-[11px] text-zinc-500">
        <span>{locale === "zh" ? `复制使用 ≈ ${s.copyCount} 次` : `Used ≈ ${s.copyCount}x`}</span>
        <span className="inline-flex items-center gap-1">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          {s.viewCount >= 1000 ? `${(s.viewCount / 1000).toFixed(1)}k` : s.viewCount}
        </span>
      </div>

      {/* 大按钮（#2563eb 蓝渐变 + 眼睛小图标） */}
      <span className="mt-2.5 flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#2563eb] to-[#3b82f6] py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-600/25 transition group-hover:brightness-110">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
        </svg>
        {locale === "zh" ? "查看技能" : "View Skill"}
      </span>
    </Link>
  );
}
