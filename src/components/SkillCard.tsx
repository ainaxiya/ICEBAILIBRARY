import Link from "next/link";
import { skillHref } from "@/lib/skill-link";
import type { Locale } from "@/lib/i18n";

// AI 技能卡片（首页「精选技能展示」与技能列表页共用）
// 设计：渐变卡片 + 说明框 + 标签 + 统计行 + 渐变按钮；flex 纵向布局保证任意屏不错位

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

const THEME: Record<string, { ring: string; badge: string; btn: string }> = {
  default: {
    ring: "hover:border-emerald-500/60",
    badge: "bg-emerald-500/10 text-emerald-300",
    btn: "from-emerald-500 to-teal-500 shadow-emerald-600/25",
  },
  violet: { ring: "hover:border-violet-500/60", badge: "bg-violet-500/10 text-violet-300", btn: "from-violet-500 to-purple-500 shadow-violet-600/25" },
  sky: { ring: "hover:border-sky-500/60", badge: "bg-sky-500/10 text-sky-300", btn: "from-sky-500 to-blue-500 shadow-sky-600/25" },
  amber: { ring: "hover:border-amber-500/60", badge: "bg-amber-500/10 text-amber-300", btn: "from-amber-500 to-orange-500 shadow-amber-600/25" },
  rose: { ring: "hover:border-rose-500/60", badge: "bg-rose-500/10 text-rose-300", btn: "from-rose-500 to-pink-500 shadow-rose-600/25" },
};

// 按分类 slug 取主题（与技能列表页 themeFor 近似；未知分类回退默认）
function themeFor(slug: string) {
  const s = (slug || "").toLowerCase();
  if (s.includes("violet") || s.includes("purple") || s.includes("ai")) return THEME.violet;
  if (s.includes("sky") || s.includes("blue") || s.includes("video") || s.includes("3d")) return THEME.sky;
  if (s.includes("amber") || s.includes("orange") || s.includes("image") || s.includes("photo")) return THEME.amber;
  if (s.includes("rose") || s.includes("pink") || s.includes("audio") || s.includes("music")) return THEME.rose;
  return THEME.default;
}

export default function SkillCard({
  s,
  locale = "zh",
}: {
  s: SkillCardData;
  locale?: Locale;
}) {
  const th = themeFor(s.category.slug);
  return (
    <Link
      href={skillHref(s.slug, s.id)}
      className={`group relative flex flex-col rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900/90 to-zinc-950/90 p-4 transition ${th.ring} hover:shadow-xl hover:shadow-zinc-950/60`}
    >
      {/* 精选徽标：卡片右上角，深红偏橙底白字 */}
      {s.featured && (
        <span className="absolute right-3 top-3 rounded bg-[#bf360c] px-1.5 py-0.5 text-[10px] font-bold text-white shadow-[0_2px_10px_rgba(191,54,12,0.45)]">★ 精选</span>
      )}
      {/* 头部：标题 + slug/分类徽章 */}
      <div className="mb-3">
        <h3 className={`line-clamp-2 font-semibold leading-snug text-zinc-50 group-hover:text-white ${s.featured ? "pr-12" : ""}`} title={s.name}>
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

      {/* 大按钮（#2563eb 蓝渐变） */}
      <span className="mt-2.5 flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-[#2563eb] to-[#3b82f6] py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-600/25 transition group-hover:brightness-110">
        {locale === "zh" ? "使用技能" : "Use Skill"} →
      </span>
    </Link>
  );
}
