import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { db } from "@/lib/db";
import PromptCard from "@/components/PromptCard";
import Pagination from "@/components/Pagination";
import CategoryIcon from "@/components/CategoryIcon";
import { getCategoryMeta, categoryDesc, LEGACY_CAT_SLUG } from "@/lib/category-meta";
import { getServerLocale, translate as t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

// 「全部提示词」聚合列表的伪 slug（不属于 Category 表，不与 2 字母码冲突）
const ALL_SLUG = "all";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = decodeURIComponent(slug);
  return { title: s === ALL_SLUG ? "全部提示词" : s };
}

export default async function CategoryDetail({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string; sort?: string }>;
}) {
  const locale = await getServerLocale();
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const sp = await searchParams;

  const isAll = slug === ALL_SLUG;

  let cat: { name: string; nameEn: string } | null = null;
  if (!isAll) {
    cat = await db.category.findUnique({ where: { slug } });
    if (!cat) {
      // 旧中文 slug → 新 2 字母码，301 永久跳转（保留 sort/page 参数）
      const legacy = LEGACY_CAT_SLUG[slug];
      if (legacy) {
        const qs = new URLSearchParams();
        if (sp.sort) qs.set("sort", sp.sort);
        if (sp.page) qs.set("page", sp.page);
        const q = qs.toString();
        permanentRedirect(`/category/${legacy}${q ? `?${q}` : ""}`);
      }
      notFound();
    }
  }

  // 左侧分类树数据：「全部提示词」合计 + 下级分类各自计数
  const [cats, groups] = await Promise.all([
    db.category.findMany({ orderBy: { sort: "asc" } }),
    db.prompt.groupBy({
      by: ["category"],
      where: { status: "published" },
      _count: { _all: true },
    }),
  ]);
  const counts = new Map(groups.map((g) => [g.category, g._count._all]));
  const totalCount = groups.reduce((a, g) => a + g._count._all, 0);

  const meta = isAll ? null : getCategoryMeta(slug);
  const sortRaw = sp.sort || "new";
  // new=最新降序(默认) old=最旧升序 views=浏览量
  const sort = ["new", "old", "views"].includes(sortRaw) ? sortRaw : "new";
  const page = Math.max(1, parseInt(sp.page || "1") || 1);

  const where = isAll
    ? { status: "published" as const }
    : { status: "published" as const, category: slug };
  const orderBy =
    sort === "old"
      ? [{ createdAt: "asc" as const }, { id: "asc" as const }]
      : sort === "views"
        ? [{ viewCount: "desc" as const }, { id: "desc" as const }]
        : [{ createdAt: "desc" as const }, { id: "desc" as const }];

  const [prompts, total] = await Promise.all([
    db.prompt.findMany({
      where,
      orderBy,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, title: true, type: true, category: true, tags: true,
        sourceAuthor: true, viewCount: true, content: true, description: true,
        coverUrl: true, featured: true,
      },
    }),
    db.prompt.count({ where }),
  ]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const name = isAll
    ? locale === "zh" ? "全部提示词" : "All Prompts"
    : locale === "zh" ? cat!.name : cat!.nameEn;
  const desc = isAll
    ? locale === "zh" ? "站内全部已发布提示词，按排序翻阅" : "All published prompts on this site"
    : categoryDesc(slug, locale);

  const sortHref = (k: string) => {
    const p = new URLSearchParams();
    if (k !== "new") p.set("sort", k);
    p.set("page", "1");
    const qs = p.toString();
    return `/category/${encodeURIComponent(slug)}${qs ? `?${qs}` : ""}`;
  };
  const sortBtn = (active: boolean, label: string, href: string, arrow?: string) => (
    <Link
      href={href}
      className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm transition ${
        active
          ? "bg-emerald-500 font-medium text-zinc-950"
          : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
      }`}
    >
      {label}
      {arrow && <span className="text-xs">{arrow}</span>}
    </Link>
  );

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* 左侧：分类树（桌面端 sticky 跟随滚动） / 手机端顶部横向滚动 */}
      <aside className="w-full shrink-0 lg:sticky lg:top-20 lg:w-56">
        <h2 className="mb-3 hidden text-sm font-medium text-zinc-400 lg:block">
          {locale === "zh" ? "提示词分类" : "Categories"}
        </h2>
        <div className="flex gap-2 overflow-x-auto pb-1 lg:max-h-[calc(100vh-7rem)] lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:pb-0">
          {/* 树根：全部提示词 */}
          <Link
            href={`/category/${ALL_SLUG}`}
            className={`shrink-0 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm transition ${
              isAll
                ? "bg-gradient-to-r from-emerald-500 to-teal-500 font-medium text-white shadow-lg shadow-emerald-600/25"
                : "bg-zinc-800/70 text-zinc-300 hover:bg-zinc-700"
            }`}
          >
            {locale === "zh" ? "全部提示词" : "All Prompts"}
            <span className="text-xs opacity-70">{totalCount}</span>
          </Link>
          {/* 下级分类（桌面端树形缩进 + 引导线） */}
          <div className="flex shrink-0 gap-2 lg:ml-2 lg:flex-col lg:border-l lg:border-zinc-800 lg:pl-3">
            {cats.map((c) => {
              const m = getCategoryMeta(c.slug);
              const active = !isAll && slug === c.slug;
              return (
                <Link
                  key={c.id}
                  href={`/category/${encodeURIComponent(c.slug)}`}
                  className={`shrink-0 inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm transition ${
                    active
                      ? `${m.bg} ${m.fg} font-medium shadow-lg`
                      : "bg-zinc-800/70 text-zinc-300 hover:bg-zinc-700"
                  }`}
                >
                  <CategoryIcon icon={m.icon} className="h-4 w-4" />
                  {locale === "zh" ? c.name : c.nameEn}
                  <span className="text-xs opacity-70">{counts.get(c.slug) || 0}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </aside>

      {/* 右侧：标题 + 排序 + 卡片网格 */}
      <div className="min-w-0 flex-1">
        <Link href="/categories" className="mb-4 inline-block text-sm text-zinc-500 hover:text-zinc-300">
          {t(locale, "catlist.back")}
        </Link>

        <div className="mb-6 flex items-start gap-4">
          <span
            className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl ${
              isAll ? "bg-zinc-700/40 text-zinc-300" : `${meta!.bg} ${meta!.fg}`
            }`}
          >
            {isAll ? <span className="text-2xl">📚</span> : <CategoryIcon icon={meta!.icon} className="h-7 w-7" />}
          </span>
          <div>
            <h1 className="text-xl font-bold text-zinc-50">{name}</h1>
            <p className="mt-1 text-sm text-zinc-400">{desc}</p>
            <p className="mt-1 text-xs text-zinc-600">{t(locale, "cat.count", { n: total })}</p>
          </div>
        </div>

        <div className="mb-5 flex flex-wrap items-center gap-2">
          {/* 最新：再点一次切换为正序（旧→新） */}
          {sort !== "old"
            ? sortBtn(sort === "new", t(locale, "sort.new"), sortHref("new"), "↓")
            : sortBtn(true, t(locale, "sort.new"), sortHref("new"), "↑")}
          {sortBtn(sort === "views", t(locale, "sort.views"), sortHref("views"))}
          <span className="ml-auto text-xs text-zinc-600">
            {sort === "old" ? "↑ 旧 → 新" : sort === "views" ? "↓ 浏览量" : "↓ 新 → 旧"}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
            {locale === "zh" ? "该分类下暂无提示词" : "No prompts in this category yet"}
          </p>
        )}

        {totalPages > 1 && (
          <Pagination
            page={page}
            totalPages={totalPages}
            basePath={`/category/${encodeURIComponent(slug)}`}
            query={{ sort: sort !== "new" ? sort : undefined }}
          />
        )}
      </div>
    </div>
  );
}
