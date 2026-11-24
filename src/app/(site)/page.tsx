import PromptCard from "@/components/PromptCard";
import SkillCard from "@/components/SkillCard";
import PromptOptimizer from "@/components/PromptOptimizer";
import { db } from "@/lib/db";
import { getServerLocale, translate as t } from "@/lib/i18n";
import { getPublicSite } from "@/lib/settings";
import Link from "next/link";

export const dynamic = "force-dynamic";

// 首页为精选流：只展示后台精选（featured=true）内容，按「后台更新时间」排序
// 排序规则：updatedAt 降序（后台设精选/编辑即刷新该时间 → 最新操作置顶）→ 相同时 viewCount 降序
// 数量对齐网格排数：提示词 3 列 × 7 排 = 21，技能 4 列 × 2 排 = 8
const HOME_PROMPTS = 21;
const HOME_SKILLS = 8;

// 首页取数：精选 + 后台可控排序（不依赖点赞/收藏/评论/年龄，无补位池）
// 网站无会员体系，互动数据不作为排序依据；updatedAt 由后台数据操作驱动，前台交互不会触碰
export default async function Home() {
  const locale = await getServerLocale();
  const site = await getPublicSite();

  const selectPrompt = {
    id: true, title: true, type: true, category: true, tags: true,
    sourceAuthor: true, viewCount: true, likeCount: true, favoriteCount: true,
    commentCount: true, createdAt: true, content: true, description: true,
    coverUrl: true, featured: true,
  } as const;
  const selectSkill = {
    id: true, slug: true, name: true, summary: true, tags: true,
    viewCount: true, copyCount: true, commentCount: true, createdAt: true,
    featured: true,
    category: { select: { slug: true, name: true, nameEn: true, icon: true } },
  } as const;

  const [prompts, skills, promptCount, skillCount] = await Promise.all([
    db.prompt.findMany({
      where: { status: "published", featured: true },
      select: selectPrompt,
      orderBy: [{ updatedAt: "desc" }, { viewCount: "desc" }],
      take: HOME_PROMPTS,
    }),
    db.skill.findMany({
      where: { status: "published", featured: true },
      select: selectSkill,
      orderBy: [{ updatedAt: "desc" }, { viewCount: "desc" }],
      take: HOME_SKILLS,
    }),
    // 神器·全能提示词优化器 统计条：库存提示词数 / 技能数
    db.prompt.count({ where: { status: "published" } }),
    db.skill.count({ where: { status: "published" } }),
  ]);

  return (
    <div>
      {/* 神器·全能提示词优化器（v0.80 替换原 banner 大图区） */}
      <PromptOptimizer
        source="home"
        siteName={site.siteName}
        promptCount={promptCount}
        skillCount={skillCount}
        rotatingLines={site.rotatingLines}
      />

      {/* 栏目大标题：精选提示词展示（英文眉题 + 两侧渐变细线 + 金色渐变外发光标题） */}
      <div className="mb-6 mt-2 text-center">
        <div className="flex items-center justify-center gap-3">
          <span className="h-px w-10 bg-gradient-to-r from-transparent to-amber-400/60 sm:w-16" />
          <span className="text-xs font-semibold uppercase tracking-[0.35em] text-amber-300/80 sm:text-xs">
            Featured Prompts
          </span>
          <span className="h-px w-10 bg-gradient-to-l from-transparent to-amber-400/60 sm:w-16" />
        </div>
        <h2 className="mt-2 bg-gradient-to-r from-amber-200 via-yellow-400 to-orange-400 bg-clip-text text-2xl font-black tracking-tight text-transparent drop-shadow-[0_0_18px_rgba(251,191,36,0.45)] sm:text-4xl">
          精选提示词展示
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {prompts.map((p) => (
          <PromptCard
            key={p.id}
            locale={locale}
            p={{ ...p, sectionCount: (p.content.match(/^\[\d+\]/gm) || []).length }}
          />
        ))}
      </div>

      {prompts.length === 0 && (
        <p className="py-20 text-center text-zinc-500">
          {locale === "zh" ? "暂无内容" : "Nothing here yet"}
        </p>
      )}

      {/* 查看全部提示词（金色主题，对应提示词区块） */}
      <div className="mt-9 flex justify-center">
        <Link
          href="/categories"
          className="flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-8 py-3 text-sm font-medium text-zinc-200 transition hover:border-amber-500 hover:text-amber-300"
        >
          {locale === "zh" ? "查看全部提示词" : t(locale, "home.viewAll")}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </Link>
      </div>

      {/* ── 精选技能展示（新增区块，青绿→靛蓝主题，与提示词区块对称）── */}
      <div className="mb-6 mt-14 text-center">
        <div className="flex items-center justify-center gap-3">
          <span className="h-px w-10 bg-gradient-to-r from-transparent to-emerald-400/60 sm:w-16" />
          <span className="text-xs font-semibold uppercase tracking-[0.35em] text-emerald-300/80 sm:text-xs">
            Featured Skills
          </span>
          <span className="h-px w-10 bg-gradient-to-l from-transparent to-emerald-400/60 sm:w-16" />
        </div>
        <h2 className="mt-2 bg-gradient-to-r from-cyan-200 via-emerald-400 to-teal-400 bg-clip-text text-2xl font-black tracking-tight text-transparent drop-shadow-[0_0_18px_rgba(52,211,153,0.45)] sm:text-4xl">
          精选技能展示
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {skills.map((s) => (
          <SkillCard key={s.id} s={s} locale={locale} />
        ))}
      </div>

      {skills.length === 0 && (
        <p className="py-16 text-center text-zinc-500">
          {locale === "zh" ? "暂无精选技能" : "No featured skills yet"}
        </p>
      )}

      <div className="mt-9 flex justify-center">
        <Link
          href="/skills"
          className="flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-8 py-3 text-sm font-medium text-zinc-200 transition hover:border-emerald-500 hover:text-emerald-300"
        >
          {locale === "zh" ? "查看全部技能" : t(locale, "home.viewAll")}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </Link>
      </div>
    </div>
  );
}
