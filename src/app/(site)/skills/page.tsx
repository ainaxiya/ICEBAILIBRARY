import Link from "next/link";
import type { CSSProperties } from "react";
import { db } from "@/lib/db";
import Pagination from "@/components/Pagination";
import { getServerLocale } from "@/lib/i18n";
import { skillHref } from "@/lib/skill-link";
import { breadcrumbJsonLd, siteUrl } from "@/lib/seo";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

// 分类 → 卡片配色（badge 多色区分 + glow 边缘发光色，RGB 空格分隔注入 --glow-rgb）
const CAT_THEMES: Record<string, { badge: string; icon: string; glow: string }> = {
  bc: { badge: "bg-sky-500/15 text-sky-300", icon: "💻", glow: "14 165 235" },
  wr: { badge: "bg-orange-500/15 text-orange-300", icon: "✍️", glow: "249 115 22" },
  de: { badge: "bg-rose-500/15 text-rose-300", icon: "🎨", glow: "244 63 94" },
  da: { badge: "bg-cyan-500/15 text-cyan-300", icon: "📊", glow: "6 182 212" },
  au: { badge: "bg-violet-500/15 text-violet-300", icon: "🤖", glow: "139 92 246" },
  ma: { badge: "bg-amber-500/15 text-amber-300", icon: "📣", glow: "245 158 11" },
  os: { badge: "bg-red-500/15 text-red-300", icon: "🛡️", glow: "239 68 68" },
  re: { badge: "bg-teal-500/15 text-teal-300", icon: "🔬", glow: "20 184 166" },
  pr: { badge: "bg-fuchsia-500/15 text-fuchsia-300", icon: "✨", glow: "217 70 239" },
};
// slug 编码 / 分类名关键词均可命中（本地 slug 为英文名，生产为两位编码，均兼容）
const NAME_THEME: [RegExp, string][] = [
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
const themeFor = (slug: string, name = "") => {
  if (CAT_THEMES[slug]) return CAT_THEMES[slug];
  const all = `${slug} ${name}`;
  for (const [re, key] of NAME_THEME) if (re.test(all)) return CAT_THEMES[key];
  return { badge: "bg-zinc-700/40 text-zinc-300", icon: "🧩", glow: "56 189 248" };
};

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

  // publishedAt 可空（采集入库的历史数据为 NULL）；PG 的 DESC 默认 NULL 排最前，
  // 必须显式 nulls:last，否则缺 publishedAt 的条目会永远钉在列表顶部
  const orderBy =
    sort === "views" ? [{ viewCount: "desc" as const }, { publishedAt: { sort: "desc" as const, nulls: "last" as const } }, { id: "desc" as const }]
    : sort === "copies" ? [{ copyCount: "desc" as const }, { publishedAt: { sort: "desc" as const, nulls: "last" as const } }, { id: "desc" as const }]
    : [{ publishedAt: { sort: "desc" as const, nulls: "last" as const } }, { createdAt: "desc" as const }, { id: "desc" as const }];

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
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: breadcrumbJsonLd([
            { name: "首页", item: siteUrl() },
            { name: "AI技能", item: siteUrl("/skills") },
          ]),
        }}
      />
      {/* 左侧：分类侧栏（桌面端 sticky 跟随滚动） / 顶部横向滚动（手机） */}
      <aside className="w-full shrink-0 lg:sticky lg:top-20 lg:w-52">
        <h2 className="mb-3 hidden text-sm font-medium text-zinc-400 lg:block">
          {locale === "zh" ? "技能分类" : "Categories"}
        </h2>
        <div className="flex gap-2 overflow-x-auto pb-1 lg:max-h-[calc(100vh-7rem)] lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:pb-0">
          <Link
            href="/skills"
            className={`cat-menu-btn shrink-0 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm ${!cat ? "active" : ""}`}
          >
            {locale === "zh" ? "全部" : "All"}
            <span className="text-xs opacity-70">{cats.reduce((a, c) => a + c._count.skills, 0)}</span>
          </Link>
          {cats.map((c) => {
            const active = cat === c.slug;
            return (
              <Link
                key={c.id}
                href={`/skills?cat=${c.slug}`}
                className={`cat-menu-btn shrink-0 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm ${active ? "active" : ""}`}
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
          {/* 说明文字仅 PC（≥1024）显示；手机版（含折叠屏展开/横屏 768–1023）不显示 */}
          <p className="hidden min-w-0 flex-1 text-sm leading-relaxed text-zinc-400 lg:block">
            {locale === "zh"
              ? "AI技能是指把复杂指令封装为整套工作流、规则、工具脚本和参考资料来扩展 AI 处理特定任务的能力。"
              : "AI skills encapsulate complex instructions into complete workflows, rules, tool scripts, and reference materials to extend an AI's ability to handle specific tasks."}
          </p>
          <div className="flex items-center gap-1.5 text-sm">
            {([
              ["new", locale === "zh" ? "最新" : "Newest"],
              ["views", locale === "zh" ? "最多查看" : "Most Viewed"],
              ["copies", locale === "zh" ? "最多复制" : "Most Copied"],
            ] as const).map(([key, label]) => (
              <Link
                key={key}
                href={sortHref(key)}
                className={`cat-menu-btn rounded-lg px-2.5 py-1 ${sort === key ? "active" : ""}`}
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
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {list.map((s) => {
              const th = themeFor(s.category.slug, s.category.name);
              return (
                <Link
                  key={s.id}
                  href={skillHref(s.slug, s.id)}
                  style={{ "--glow-rgb": th.glow } as CSSProperties}
                  className="skill-glow group relative flex flex-col overflow-hidden rounded-2xl border bg-gradient-to-b from-zinc-900/90 to-zinc-950/90 p-5 transition hover:-translate-y-0.5"
                >
                  <div className="relative flex flex-1 flex-col">
                    {/* 头部：标题（最多两行）+ 精选徽章 + 分类徽章 */}
                    <div className="mb-1.5 flex items-start justify-between gap-3">
                      <h3 className="skill-title line-clamp-2 text-lg font-semibold leading-snug text-zinc-50" title={s.name}>
                        {s.name}
                      </h3>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {s.featured && (
                          <span className="rounded-md bg-[#bf360c] px-1.5 py-1 text-xs font-bold text-white shadow-[0_2px_10px_rgba(191,54,12,0.45)]">★ 精选</span>
                        )}
                        <span className={`rounded-md px-2 py-1 text-xs font-medium ${th.badge}`}>
                          {(s.category as any).icon && <span className="mr-0.5">{(s.category as any).icon}</span>}
                          {locale === "zh" ? s.category.name : s.category.nameEn}
                        </span>
                      </div>
                    </div>
                    <div className="mb-3 text-xs text-zinc-500">
                      <span className="truncate">{s.slug}</span>
                    </div>

                    {/* 说明 */}
                    <div className="mb-3 rounded-xl bg-zinc-800/40 p-3">
                      <p className="mb-1 text-xs font-medium text-zinc-400">📄 {locale === "zh" ? "说明" : "About"}</p>
                      <p className="line-clamp-2 text-xs leading-relaxed text-zinc-300">{s.summary}</p>
                    </div>

                    {/* 关联标签 */}
                    {s.tags.length > 0 && (
                      <div className="mb-3 flex flex-wrap items-center gap-1.5">
                        <span className="mr-0.5 text-xs font-medium text-zinc-400">🏷 {locale === "zh" ? "关联标签" : "Tags"}</span>
                        {s.tags.slice(0, 4).map((tag) => (
                          <span key={tag} className={`rounded-md px-2 py-0.5 text-xs ${th.badge}`}>{tag}</span>
                        ))}
                      </div>
                    )}

                    {/* 底部：使用量 + 大按钮 */}
                    <div className="mt-auto flex items-center justify-between gap-3 pt-1">
                      <div className="flex items-center gap-3 text-xs text-zinc-500">
                        <span>{locale === "zh" ? `复制使用 ≈ ${s.copyCount} 次` : `Used ≈ ${s.copyCount}x`}</span>
                        <span className="inline-flex items-center gap-1">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                          {s.viewCount >= 1000 ? `${(s.viewCount / 1000).toFixed(1)}k` : s.viewCount}
                        </span>
                      </div>
                      <span className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#2563eb] to-[#3b82f6] px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-600/25 transition group-hover:brightness-110">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                        </svg>
                        {locale === "zh" ? "查看技能" : "View Skill"}
                      </span>
                    </div>
                  </div>
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
