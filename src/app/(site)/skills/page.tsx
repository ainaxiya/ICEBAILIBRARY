import Link from "next/link";
import { db } from "@/lib/db";
import Pagination from "@/components/Pagination";
import { getServerLocale } from "@/lib/i18n";
import { skillHref } from "@/lib/skill-link";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

// 分类 → 卡片配色（按 slug 轮换，保证相邻分类不同色）
const CAT_THEMES: Record<string, { badge: string; icon: string; ring: string }> = {
  bc: { badge: "bg-sky-500/15 text-sky-300", icon: "💻", ring: "hover:border-sky-600/60" },
  wr: { badge: "bg-orange-500/15 text-orange-300", icon: "✍️", ring: "hover:border-orange-600/60" },
  de: { badge: "bg-rose-500/15 text-rose-300", icon: "🎨", ring: "hover:border-rose-600/60" },
  da: { badge: "bg-cyan-500/15 text-cyan-300", icon: "📊", ring: "hover:border-cyan-600/60" },
  au: { badge: "bg-violet-500/15 text-violet-300", icon: "🤖", ring: "hover:border-violet-600/60" },
  ma: { badge: "bg-amber-500/15 text-amber-300", icon: "📣", ring: "hover:border-amber-600/60" },
  os: { badge: "bg-red-500/15 text-red-300", icon: "🛡️", ring: "hover:border-red-600/60" },
  re: { badge: "bg-teal-500/15 text-teal-300", icon: "🔬", ring: "hover:border-teal-600/60" },
  pr: { badge: "bg-fuchsia-500/15 text-fuchsia-300", icon: "✨", ring: "hover:border-fuchsia-600/60" },
};
const themeFor = (slug: string) => CAT_THEMES[slug] || { badge: "bg-zinc-700/40 text-zinc-300", icon: "🧩", ring: "hover:border-emerald-600/60" };

type SearchParams = Promise<{ cat?: string; sort?: string; q?: string; page?: string }>;

export async function generateMetadata() {
  return {
    title: "AI 技能",
    description: "AI 技能（SKILL.md）集合站：智能体工作流、自动化任务、工具调用等可直接复制使用的技能文件",
  };
}

export default async function SkillsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const locale = await getServerLocale();
  const page = Math.max(1, parseInt(sp.page || "1") || 1);
  const cat = (sp.cat || "").trim();
  const sort = sp.sort === "views" || sp.sort === "copies" ? sp.sort : "new";
  const q = (sp.q || "").trim();

  const cats = await db.skillCategory.findMany({
    orderBy: { sort: "asc" },
    include: { _count: { select: { skills: { where: { status: "published" } } } } },
  });

  const where: any = { status: "published" };
  if (cat) where.category = { slug: cat };
  if (q) where.OR = [
    { name: { contains: q, mode: "insensitive" } },
    { summary: { contains: q, mode: "insensitive" } },
    { tags: { has: q } },
  ];

  const orderBy =
    sort === "views" ? [{ viewCount: "desc" as const }, { publishedAt: "desc" as const }]
    : sort === "copies" ? [{ copyCount: "desc" as const }, { publishedAt: "desc" as const }]
    : [{ publishedAt: "desc" as const }];

  const [list, total] = await Promise.all([
    db.skill.findMany({
      where,
      orderBy,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { category: { select: { name: true, nameEn: true, slug: true, icon: true } } },
    }),
    db.skill.count({ where }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const query = { cat: cat || undefined, sort: sort === "new" ? undefined : sort, q: q || undefined };
  const sortHref = (s: string) => {
    const p = new URLSearchParams();
    if (cat) p.set("cat", cat);
    if (q) p.set("q", q);
    if (s !== "new") p.set("sort", s);
    return `/skills${p.size ? `?${p}` : ""}`;
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* 左侧：分类侧栏（桌面） / 顶部横向滚动（手机） */}
      <aside className="w-full shrink-0 lg:w-52">
        <h2 className="mb-3 hidden text-sm font-medium text-zinc-400 lg:block">
          {locale === "zh" ? "技能分类" : "Categories"}
        </h2>
        <div className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
          <Link
            href="/skills"
            className={`shrink-0 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm transition ${!cat ? "bg-gradient-to-r from-emerald-500 to-teal-500 font-medium text-white shadow-lg shadow-emerald-600/25" : "bg-zinc-800/70 text-zinc-300 hover:bg-zinc-700"}`}
          >
            {locale === "zh" ? "全部" : "All"}
            <span className="text-xs opacity-70">{cats.reduce((a, c) => a + c._count.skills, 0)}</span>
          </Link>
          {cats.map((c) => {
            const th = themeFor(c.slug);
            const active = cat === c.slug;
            return (
              <Link
                key={c.id}
                href={`/skills?cat=${c.slug}`}
                className={`shrink-0 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm transition ${active ? `${th.badge} font-medium shadow-lg` : "bg-zinc-800/70 text-zinc-300 hover:bg-zinc-700"}`}
              >
                {c.icon && <span className="text-sm leading-none">{c.icon}</span>}
                {locale === "zh" ? c.name : c.nameEn}
                <span className="text-xs opacity-70">{c._count.skills}</span>
              </Link>
            );
          })}
        </div>
      </aside>

      {/* 右侧：标题 + 排序 + 卡片网格 */}
      <div className="min-w-0 flex-1">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold">
            {locale === "zh" ? "AI 技能" : "AI Skills"}
            <span className="ml-2 text-sm font-normal text-zinc-500">({total})</span>
          </h1>
          <div className="ml-auto flex items-center gap-1.5 text-sm">
            {([
              ["new", locale === "zh" ? "最新" : "Newest"],
              ["views", locale === "zh" ? "最多查看" : "Most Viewed"],
              ["copies", locale === "zh" ? "最多复制" : "Most Copied"],
            ] as const).map(([key, label]) => (
              <Link
                key={key}
                href={sortHref(key)}
                className={`rounded-lg px-2.5 py-1 transition ${sort === key ? "bg-emerald-500/15 text-emerald-300" : "text-zinc-400 hover:text-zinc-200"}`}
              >
                {label}
              </Link>
            ))}
          </div>
        </div>

        {q && (
          <p className="mb-3 text-sm text-zinc-500">
            {locale === "zh" ? `搜索「${q}」：` : `Search "${q}": `}{total} {locale === "zh" ? "条结果" : "results"}
            <Link href="/skills" className="ml-2 text-emerald-400 hover:underline">{locale === "zh" ? "清除" : "Clear"}</Link>
          </p>
        )}

        {list.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 py-16 text-center text-zinc-500">
            {locale === "zh" ? "暂无技能" : "No skills yet"}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((s) => {
              const th = themeFor(s.category.slug);
              return (
                <Link
                  key={s.id}
                  href={skillHref(s.slug, s.id)}
                  className={`group flex flex-col rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900/90 to-zinc-950/90 p-4 transition ${th.ring} hover:shadow-xl hover:shadow-zinc-950/60`}
                >
                  {/* 头部：标题（整行，最多两行）+ slug/分类徽章 */}
                  <div className="mb-3">
                    <h3 className="line-clamp-2 font-semibold leading-snug text-zinc-50 group-hover:text-white" title={s.name}>
                      {s.name}
                    </h3>
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
                      <span className="truncate text-zinc-500">{s.slug}</span>
                      <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${th.badge}`}>
                        {(s.category as any).icon && <span className="mr-0.5">{(s.category as any).icon}</span>}
                        {locale === "zh" ? s.category.name : s.category.nameEn}
                      </span>
                    </div>
                  </div>

                  {/* 说明 */}
                  <div className="mb-2.5 rounded-xl bg-zinc-800/40 p-2.5">
                    <p className="mb-1 text-[11px] font-medium text-zinc-400">📄 {locale === "zh" ? "说明" : "About"}</p>
                    <p className="line-clamp-2 text-xs leading-relaxed text-zinc-300">{s.summary}</p>
                  </div>

                  {/* 关联标签 */}
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

                  {/* 使用量行 */}
                  <div className="mt-auto flex items-center justify-between pt-1 text-[11px] text-zinc-500">
                    <span>{locale === "zh" ? `复制使用 ≈ ${s.copyCount} 次` : `Used ≈ ${s.copyCount}x`}</span>
                    <span className="inline-flex items-center gap-1">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                      {s.viewCount >= 1000 ? `${(s.viewCount / 1000).toFixed(1)}k` : s.viewCount}
                    </span>
                  </div>

                  {/* 大按钮 */}
                  <span className="mt-2.5 flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-600/25 transition group-hover:brightness-110">
                    {locale === "zh" ? "使用技能" : "Use Skill"} →
                  </span>
                </Link>
              );
            })}
          </div>
        )}

        <Pagination page={page} totalPages={totalPages} basePath="/skills" query={query} />
      </div>
    </div>
  );
}
