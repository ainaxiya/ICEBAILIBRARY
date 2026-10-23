import Link from "next/link";
import { db } from "@/lib/db";
import Pagination from "@/components/Pagination";
import { getServerLocale } from "@/lib/i18n";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

// 软件卡片配色：按分类 slug 轮换，保证不同分类不同色
const SOFT_THEMES: Record<string, { grad: string; ring: string; chip: string }> = {
  default: { grad: "from-sky-500/15 via-zinc-900/70 to-zinc-950/80", ring: "hover:border-sky-500/60", chip: "bg-sky-500/15 text-sky-300" },
};
const THEME_POOL = [
  { grad: "from-sky-500/15 via-zinc-900/70 to-zinc-950/80", ring: "hover:border-sky-500/60", chip: "bg-sky-500/15 text-sky-300" },
  { grad: "from-violet-500/15 via-zinc-900/70 to-zinc-950/80", ring: "hover:border-violet-500/60", chip: "bg-violet-500/15 text-violet-300" },
  { grad: "from-rose-500/15 via-zinc-900/70 to-zinc-950/80", ring: "hover:border-rose-500/60", chip: "bg-rose-500/15 text-rose-300" },
  { grad: "from-amber-500/15 via-zinc-900/70 to-zinc-950/80", ring: "hover:border-amber-500/60", chip: "bg-amber-500/15 text-amber-300" },
  { grad: "from-cyan-500/15 via-zinc-900/70 to-zinc-950/80", ring: "hover:border-cyan-500/60", chip: "bg-cyan-500/15 text-cyan-300" },
  { grad: "from-fuchsia-500/15 via-zinc-900/70 to-zinc-950/80", ring: "hover:border-fuchsia-500/60", chip: "bg-fuchsia-500/15 text-fuchsia-300" },
  { grad: "from-teal-500/15 via-zinc-900/70 to-zinc-950/80", ring: "hover:border-teal-500/60", chip: "bg-teal-500/15 text-teal-300" },
  { grad: "from-orange-500/15 via-zinc-900/70 to-zinc-950/80", ring: "hover:border-orange-500/60", chip: "bg-orange-500/15 text-orange-300" },
];
const themeFor = (slug: string) => {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SOFT_THEMES[slug] || THEME_POOL[h % THEME_POOL.length];
};

type SearchParams = Promise<{ cat?: string; sort?: string; q?: string; page?: string }>;

export async function generateMetadata() {
  return {
    title: "AI 软件",
    description: "精选 AI 软件下载站：AI 客户端、效率工具、创作软件，提供本站直链与对象存储安全下载",
  };
}

export default async function SoftwarePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const locale = await getServerLocale();
  const page = Math.max(1, parseInt(sp.page || "1") || 1);
  const cat = (sp.cat || "").trim();
  const sort = sp.sort === "views" || sp.sort === "downloads" ? sp.sort : "new";
  const q = (sp.q || "").trim();

  const cats = await db.softwareCategory.findMany({
    orderBy: { sort: "asc" },
    include: { _count: { select: { software: { where: { status: "published" } } } } },
  });

  const where: any = { status: "published" };
  if (cat) where.category = { slug: cat };
  if (q) where.OR = [
    { name: { contains: q, mode: "insensitive" } },
    { tagline: { contains: q, mode: "insensitive" } },
    { tags: { has: q } },
  ];

  const orderBy =
    sort === "views" ? [{ viewCount: "desc" as const }, { publishedAt: "desc" as const }]
    : sort === "downloads" ? [{ downloadCount: "desc" as const }, { publishedAt: "desc" as const }]
    : [{ publishedAt: "desc" as const }];

  const [list, total] = await Promise.all([
    db.software.findMany({
      where,
      orderBy,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { category: { select: { name: true, nameEn: true, slug: true, icon: true } } },
    }),
    db.software.count({ where }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const query = { cat: cat || undefined, sort: sort === "new" ? undefined : sort, q: q || undefined };
  const sortHref = (s: string) => {
    const p = new URLSearchParams();
    if (cat) p.set("cat", cat);
    if (q) p.set("q", q);
    if (s !== "new") p.set("sort", s);
    return `/software${p.size ? `?${p}` : ""}`;
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* 左侧：分类侧栏（桌面） / 顶部横向滚动（手机） */}
      <aside className="w-full shrink-0 lg:w-52">
        <h2 className="mb-3 hidden text-sm font-medium text-zinc-400 lg:block">
          {locale === "zh" ? "软件分类" : "Categories"}
        </h2>
        <div className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
          <Link
            href="/software"
            className={`shrink-0 rounded-xl px-3 py-2 text-sm transition ${!cat ? "bg-gradient-to-r from-emerald-500 to-teal-500 font-medium text-white shadow-lg shadow-emerald-600/25" : "bg-zinc-800/70 text-zinc-300 hover:bg-zinc-700"}`}
          >
            {locale === "zh" ? "全部" : "All"}
            <span className="ml-1.5 text-xs opacity-70">{cats.reduce((a, c) => a + c._count.software, 0)}</span>
          </Link>
          {cats.map((c) => {
            const th = themeFor(c.slug);
            const active = cat === c.slug;
            return (
              <Link
                key={c.id}
                href={`/software?cat=${c.slug}`}
                className={`shrink-0 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm transition ${active ? `${th.chip} font-medium shadow-lg` : "bg-zinc-800/70 text-zinc-300 hover:bg-zinc-700"}`}
              >
                {c.icon && <span className="text-sm leading-none">{c.icon}</span>}
                {locale === "zh" ? c.name : c.nameEn}
                <span className="text-xs opacity-70">{c._count.software}</span>
              </Link>
            );
          })}
        </div>
      </aside>

      {/* 右侧：标题 + 排序 + 卡片网格 */}
      <div className="min-w-0 flex-1">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold">
            {locale === "zh" ? "AI 软件" : "AI Software"}
            <span className="ml-2 text-sm font-normal text-zinc-500">({total})</span>
          </h1>
          <div className="ml-auto flex items-center gap-1.5 text-sm">
            {([
              ["new", locale === "zh" ? "最新" : "Newest"],
              ["views", locale === "zh" ? "最多查看" : "Most Viewed"],
              ["downloads", locale === "zh" ? "最多下载" : "Most Downloaded"],
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
            <Link href="/software" className="ml-2 text-emerald-400 hover:underline">{locale === "zh" ? "清除" : "Clear"}</Link>
          </p>
        )}

        {list.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 py-16 text-center text-zinc-500">
            {locale === "zh" ? "暂无软件" : "No software yet"}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((s) => {
              const th = themeFor(s.category.slug);
              return (
                <Link
                  key={s.id}
                  href={`/software/${s.slug}`}
                  className={`group flex flex-col rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900/90 to-zinc-950/90 p-4 transition ${th.ring} hover:shadow-xl hover:shadow-zinc-950/60`}
                >
                  {/* 大图标 */}
                  {s.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={s.icon} alt={s.name} className="h-20 w-20 rounded-2xl border border-zinc-700/60 object-cover shadow-xl" />
                  ) : (
                    <span className={`grid h-20 w-20 place-items-center rounded-2xl text-3xl shadow-xl ${th.chip}`}>
                      {(s.category as any).icon || s.name.slice(0, 1)}
                    </span>
                  )}
                  {/* 版本 + 名称 + 简介 */}
                  <div className="mt-3 flex items-center gap-2">
                    {s.version && <span className="text-[11px] text-zinc-500">{s.version}</span>}
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${th.chip}`}>
                      {locale === "zh" ? s.category.name : s.category.nameEn}
                    </span>
                  </div>
                  <h3 className="mt-1 truncate text-base font-bold text-zinc-50 group-hover:text-white" title={s.name}>
                    {s.name}
                  </h3>
                  <p className="mt-1 line-clamp-2 flex-1 text-xs leading-relaxed text-zinc-400">{s.tagline}</p>
                  {/* 底部统计行 */}
                  <div className="mt-3 flex items-center gap-3 text-[11px] text-zinc-500">
                    <span className="inline-flex items-center gap-1">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      {s.downloadCount}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                      {s.viewCount}
                    </span>
                    {s.publishedAt && (
                      <span className="ml-auto inline-flex items-center gap-1">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        {new Date(s.publishedAt).toISOString().slice(5, 10)}
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        <Pagination page={page} totalPages={totalPages} basePath="/software" query={query} />
      </div>
    </div>
  );
}
