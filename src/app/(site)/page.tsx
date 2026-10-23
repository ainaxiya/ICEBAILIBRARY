import PromptCard from "@/components/PromptCard";
import PromptOptimizer from "@/components/PromptOptimizer";
import { db } from "@/lib/db";
import { getServerLocale, translate as t } from "@/lib/i18n";
import { getPublicSite } from "@/lib/settings";
import Link from "next/link";

export const dynamic = "force-dynamic";

// 首页为精选流：精华内容置顶，高赞/高浏览补足，不分页
const HOME_TAKE = 30;

export default async function Home() {
  const locale = await getServerLocale();
  const site = await getPublicSite();

  const prompts = await db.prompt.findMany({
    where: {
      status: "published",
      featured : true,
      },
    
    orderBy: [
      { updatedAt: "desc" },
      { viewCount: "desc" },
    ],
    take: HOME_TAKE,
    select: {
      id: true, title: true, type: true, category: true, tags: true,
      sourceAuthor: true, viewCount: true, content: true, description: true,
      coverUrl: true, featured: true,
    },
  });

  // 神器·全能提示词优化器 统计条：库存提示词数 / 技能数
  const [promptCount, skillCount] = await Promise.all([
    db.prompt.count({ where: { status: "published" } }),
    db.skill.count(),
  ]);

  return (
    <div>
      {/* 神器·全能提示词优化器（v0.80 替换原 banner 大图区） */}
      <PromptOptimizer
        source="home"
        siteName={site.siteName}
        promptCount={promptCount}
        skillCount={skillCount}
      />

      {/* 栏目大标题：精选提示词展示（英文眉题 + 两侧渐变细线 + 金色渐变外发光标题） */}
      <div className="mb-6 mt-2 text-center">
        <div className="flex items-center justify-center gap-3">
          <span className="h-px w-10 bg-gradient-to-r from-transparent to-amber-400/60 sm:w-16" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.35em] text-amber-300/80 sm:text-xs">
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

      <div className="mt-10 flex justify-center">
        <Link
          href="/categories"
          className="flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-8 py-3 text-sm font-medium text-zinc-200 transition hover:border-emerald-500 hover:text-emerald-300"
        >
          {t(locale, "home.viewAll")}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </Link>
      </div>
    </div>
  );
}
