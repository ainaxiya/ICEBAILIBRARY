import Link from "next/link";
import type { ReactNode } from "react";
import { meili } from "@/lib/meili";
import Pagination from "@/components/Pagination";
import { getServerLocale, translate as t } from "@/lib/i18n";
import { db } from "@/lib/db";
import { skillHref } from "@/lib/skill-link";
import {
  SEARCH_BAR_BUTTON_CLASS,
  SEARCH_BAR_BUTTON_ICON_CLASS,
  SEARCH_BAR_FORM_CLASS,
  SEARCH_BAR_ICON_CLASS,
  SEARCH_BAR_INPUT_CLASS,
} from "@/lib/search-bar-style";

export const dynamic = "force-dynamic";

export const metadata = { title: "搜索 / Search", robots: { index: false, follow: true } };

// 关键词高亮标记（控制字符，不可能出现在正文里）
const HL_PRE = String.fromCharCode(1);
const HL_POST = String.fromCharCode(2);

const HL_CFG = {
  prompts: {
    hl: ["title", "description", "content"],
    crop: ["description", "content"],
  },
  skills: {
    hl: ["name", "summary"],
    crop: ["summary"],
  },
} as const;

// v0.117 AI 软件下线：搜索范围只保留 提示词 / 技能
const TYPES = ["prompt", "skill"] as const;
type TypeKey = (typeof TYPES)[number];

const TYPE_CFG: Record<TypeKey, { index: string; facet: string }> = {
  prompt: { index: "prompts", facet: "category" },
  skill: { index: "skills", facet: "categorySlug" },
};

const TYPE_STYLE: Record<
  TypeKey,
  { tile: string; badge: string; accent: string; label: Record<"zh" | "en", string> }
> = {
  prompt: {
    tile: "from-emerald-400/25 to-emerald-600/10 text-emerald-300 ring-emerald-400/30",
    badge: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/25",
    accent: "from-emerald-400 via-emerald-500/60 to-transparent",
    label: { zh: "提示词", en: "Prompts" },
  },
  skill: {
    tile: "from-violet-400/25 to-violet-600/10 text-violet-300 ring-violet-400/30",
    badge: "bg-violet-500/15 text-violet-300 ring-violet-400/25",
    accent: "from-violet-400 via-violet-500/60 to-transparent",
    label: { zh: "AI技能", en: "Skills" },
  },
};

function TypeIcon({ type, className }: { type: TypeKey; className?: string }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (type === "prompt") {
    return (
      <svg viewBox="0 0 24 24" className={className} {...common}>
        <path d="M8 6 3 12l5 6M16 6l5 6-5 6M13.5 4l-3 16" />
      </svg>
    );
  }
  if (type === "skill") {
    return (
      <svg viewBox="0 0 24 24" className={className} {...common}>
        <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={className} {...common}>
      <path d="M21 8.5v7L12 21l-9-5.5v-7L12 3l9 5.5ZM3.3 8.7 12 13.5l8.7-4.8M12 21v-7.5" />
    </svg>
  );
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// 解析高亮标记为金色 <mark> 片段
function Marked({ text }: { text?: string | null }) {
  if (!text) return null;
  const out: ReactNode[] = [];
  const re = new RegExp(`${HL_PRE}([\\s\\S]*?)${HL_POST}`, "g");
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <mark
        key={k++}
        className="mx-[1px] rounded bg-royal-300/20 px-[3px] font-semibold text-royal-200 shadow-[inset_0_-2px_0_rgba(103,232,249,0.4)]"
      >
        {m[1]}
      </mark>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

// 相关度补偿分：标题命中权重大于简介，全部词命中额外加分
function matchScore(h: Record<string, any>, terms: string[]): number {
  const f = h._formatted || {};
  const title = String(f.title ?? f.name ?? h.title ?? h.name ?? "").toLowerCase();
  const desc = String(f.description ?? f.summary ?? f.tagline ?? "").toLowerCase();
  let s = 0;
  let all = terms.length > 0;
  for (const raw of terms) {
    const w = raw.toLowerCase();
    if (!w) continue;
    let hit = false;
    if (title.includes(w)) {
      s += 0.12;
      hit = true;
    }
    if (desc.includes(w)) {
      s += 0.03;
      hit = true;
    }
    if (!hit) all = false;
  }
  if (all) s += 0.1;
  return s;
}

function fmtDate(ts: number, locale: "zh" | "en") {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

type Row = {
  key: string;
  tp: TypeKey;
  id: number;
  title: string;
  desc: string;
  viewCount: number;
  ts: number;
  catSlug: string;
  slug: string | null;
  raw: Record<string, any>;
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    page?: string;
    type?: string;
    category?: string;
    sort?: string;
  }>;
}) {
  const locale = await getServerLocale();
  const sp = await searchParams;
  const q = (sp.q || "").trim();
  const page = Math.max(1, parseInt(sp.page || "1") || 1);
  const type = (TYPES as readonly string[]).includes(sp.type || "") ? (sp.type as TypeKey) : "";
  const category = (sp.category || "").replace(/[^a-zA-Z0-9_-]/g, "");
  const sort = sp.sort === "new" ? "new" : "";
  const pageSize = 20;
  const zh = locale === "zh";

  const [promptCats, skillCats] = await Promise.all([
    db.category.findMany({ orderBy: { sort: "asc" }, select: { slug: true, name: true, nameEn: true } }),
    db.skillCategory.findMany({ orderBy: { sort: "asc" }, select: { slug: true, name: true, nameEn: true } }),
  ]);
  const catList: Record<TypeKey, { slug: string; name: string; nameEn: string }[]> = {
    prompt: promptCats,
    skill: skillCats,
  };
  const catNameOf = (tp: TypeKey, slug: string) => {
    const c = catList[tp].find((x) => x.slug === slug);
    return c ? (zh ? c.name : c.nameEn) : "";
  };

  const terms = q ? q.split(/\s+/).filter(Boolean) : [];

  // 查询链接拼装（清除参数时传空串）
  const qs = (over: Record<string, string | number | undefined>) => {
    const base: Record<string, string> = {};
    if (q) base.q = q;
    if (type) base.type = type;
    if (category) base.category = category;
    if (sort) base.sort = sort;
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined || v === "") delete base[k];
      else base[k] = String(v);
    }
    return "/search?" + new URLSearchParams(base).toString();
  };

  // ── 类型筛选树计数 + 结果查询：互不依赖，并行发起 ──
  const facetCounts: Record<string, { total: number; subs: Record<string, number> }> = {};
  let rows: Row[] = [];
  let total = 0;
  let error = "";
  if (q) {
    const facetQueries = TYPES.map((tp) => ({
      indexUid: TYPE_CFG[tp].index,
      q,
      limit: 1,
      facets: [TYPE_CFG[tp].facet],
      attributesToRetrieve: ["id"],
    }));

    const hlOf = (idx: string) => {
      const cfg = (HL_CFG as Record<string, { hl: readonly string[]; crop: readonly string[] }>)[idx];
      return {
        attributesToHighlight: [...cfg.hl],
        attributesToCrop: [...cfg.crop],
        cropLength: 32,
        cropMarker: "…",
        highlightPreTag: HL_PRE,
        highlightPostTag: HL_POST,
      };
    };

    const wanted: TypeKey[] = type ? [type] : [...TYPES];
    const catFilter = (tp: TypeKey) => {
      if (!category) return undefined;
      const field = tp === "prompt" ? "category" : "categorySlug";
      return `${field} = "${category}"`;
    };
    const resultQueries = wanted.map((tp) => ({
      indexUid: TYPE_CFG[tp].index,
      q,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      filter: catFilter(tp),
      ...(sort === "new" ? { sort: ["createdAtTs:desc"] } : {}),
      showRankingScore: true,
      ...hlOf(TYPE_CFG[tp].index),
    }));

    // facet 失败仅不显示计数；结果失败显示错误文案
    const [fr, rr] = await Promise.all([
      meili.multiSearch({ queries: facetQueries }).catch(() => null),
      meili.multiSearch({ queries: resultQueries }).catch((e: any) => {
        error = t(locale, "search.engineDown", { msg: e?.message || e });
        return null;
      }),
    ]);

    if (fr) {
      TYPES.forEach((tp, i) => {
        const r = (fr.results || [])[i] || {};
        const dist = (r.facetDistribution || {})[TYPE_CFG[tp].facet] || {};
        facetCounts[tp] = {
          total: r.estimatedTotalHits ?? r.totalHits ?? 0,
          subs: dist as Record<string, number>,
        };
      });
    }

    if (rr) {
      const merged: (Row & { rank: number })[] = [];
      wanted.forEach((tp, i) => {
        const r = (rr.results || [])[i] || {};
        total += r.estimatedTotalHits ?? r.totalHits ?? 0;
        for (const h of r.hits || []) {
          const f = h._formatted || {};
          merged.push({
            key: `${tp}-${h.id}`,
            tp,
            id: h.id,
            title: String(f.title ?? f.name ?? h.title ?? h.name ?? ""),
            desc: String(f.description ?? f.summary ?? f.tagline ?? ""),
            viewCount: h.viewCount ?? 0,
            ts: h.createdAtTs ?? 0,
            catSlug: h.category ?? h.categorySlug ?? "",
            slug: h.slug ?? null,
            raw: h,
            rank: typeof h._rankingScore === "number" ? h._rankingScore : 0,
          });
        }
      });
      merged.sort((a, b) => {
        if (sort === "new") return (b.ts ?? 0) - (a.ts ?? 0);
        const sa = a.rank + matchScore(a.raw, terms);
        const sb = b.rank + matchScore(b.raw, terms);
        if (sb !== sa) return sb - sa;
        return (b.ts ?? 0) - (a.ts ?? 0);
      });
      rows = merged.slice(0, pageSize).map(({ rank: _rank, ...row }) => row);
    }
  }
  const facetTotal = TYPES.reduce((n, tp) => n + (facetCounts[tp]?.total || 0), 0);

  // 技能的详情链接需要 slug，索引缺失时回查数据库
  const skillIds = rows.filter((r) => r.tp === "skill" && !r.slug).map((r) => r.id);
  const skSlugs = skillIds.length
    ? await db.skill.findMany({ where: { id: { in: skillIds } }, select: { id: true, slug: true } })
    : [];
  const slugMap = new Map<number, string>();
  for (const s of skSlugs) slugMap.set(s.id, s.slug);
  const hrefOf = (r: Row) => {
    const slug = r.slug || slugMap.get(r.id) || String(r.id);
    return r.tp === "skill" ? skillHref(slug, r.id) : `/p/${r.id}`;
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const activeCount = (type ? 1 : 0) + (category ? 1 : 0);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6 sm:px-6">
      {/* ── HERO：搜索头部 ── */}
      <section className="relative mx-auto max-w-5xl overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-4 sm:px-6 sm:py-5">
        <div aria-hidden className="pointer-events-none absolute -top-28 -right-20 h-72 w-72 rounded-full bg-emerald-500/25 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-royal-400/15 blur-3xl" />
        <div className="relative">
          {/* 搜索框 */}
          <form action="/search" method="GET" className={SEARCH_BAR_FORM_CLASS}>
            {type && <input type="hidden" name="type" value={type} />}
            {category && <input type="hidden" name="category" value={category} />}
            <svg viewBox="0 0 24 24" className={SEARCH_BAR_ICON_CLASS} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              name="q"
              defaultValue={q}
              placeholder={t(locale, "search.placeholder")}
              className={SEARCH_BAR_INPUT_CLASS}
            />
            <button type="submit" className={SEARCH_BAR_BUTTON_CLASS}>
              {t(locale, "search.button")}
              <svg viewBox="0 0 24 24" className={SEARCH_BAR_BUTTON_ICON_CLASS} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </form>

          {/* 结果概览 + 已选筛选 + 排序 */}
          {q && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-200">
                {t(locale, "search.results", { n: total })}
              </span>
              {type && (
                <Link
                  href={qs({ type: "", category: "" })}
                  className="inline-flex items-center gap-1.5 rounded-full border border-royal-300/40 bg-royal-400/15 px-3 py-1 text-xs font-medium text-royal-200 transition hover:bg-royal-400/25"
                >
                  {TYPE_STYLE[type].label[zh ? "zh" : "en"]}
                  <span className="text-royal-300/70">×</span>
                </Link>
              )}
              {type && category && (
                <Link
                  href={qs({ category: "" })}
                  className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/80 px-3 py-1 text-xs font-medium text-zinc-300 transition hover:border-zinc-600"
                >
                  {catNameOf(type, category) || category}
                  <span className="text-zinc-500">×</span>
                </Link>
              )}
              <div className="ml-auto inline-flex rounded-full border border-zinc-700 bg-zinc-950/60 p-1 text-xs">
                <Link
                  href={qs({ sort: "" })}
                  className={`rounded-full px-3.5 py-1.5 font-medium transition ${
                    !sort ? "bg-emerald-500 text-white shadow-[0_4px_14px_-4px_rgba(56,189,248,0.7)]" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {t(locale, "sort.relevance")}
                </Link>
                <Link
                  href={qs({ sort: "new" })}
                  className={`rounded-full px-3.5 py-1.5 font-medium transition ${
                    sort === "new" ? "bg-emerald-500 text-white shadow-[0_4px_14px_-4px_rgba(56,189,248,0.7)]" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {t(locale, "sort.new")}
                </Link>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── 主体：结果列表 + 类型筛选 ── */}
      <div className="mt-8 flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* 类型筛选：手机置顶，桌面左侧吸顶常驻 */}
        <aside className="lg:sticky lg:top-[4.5rem] lg:w-64 lg:shrink-0">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                <span className="inline-block h-4 w-1 rounded-full bg-royal-400" />
                {t(locale, "search.scopeTitle")}
              </h2>
              {activeCount > 0 && (
                <Link href={qs({ type: "", category: "" })} className="text-xs text-emerald-300 transition hover:text-emerald-200">
                  {zh ? "清除筛选" : "Clear"}
                </Link>
              )}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-1">
              {/* 全部内容 */}
              <Link
                href={qs({ type: "", category: "" })}
                className={`cat-menu-btn flex items-center gap-1 rounded-xl border border-zinc-800 px-2.5 py-2.5 text-xs lg:gap-2.5 lg:px-3 lg:text-sm ${!type ? "active" : ""}`}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-zinc-700/60 to-zinc-800/60 text-zinc-300 ring-1 ring-zinc-700 lg:h-8 lg:w-8">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                </span>
                <span className="flex-1 truncate">
                  <span className="lg:hidden">{zh ? "全部" : "All"}</span>
                  <span className="hidden lg:inline">{zh ? "全部内容" : "All"}</span>
                </span>
                <span className="shrink-0 rounded-full bg-zinc-800 px-1 py-0.5 text-xs tabular-nums text-zinc-400 lg:px-2 lg:text-xs">{facetTotal}</span>
              </Link>

              {/* 三个类型节点（details 展开下级分类） */}
              {TYPES.map((tp) => {
                const st = TYPE_STYLE[tp];
                const active = type === tp;
                const subs = catList[tp];
                return (
                  <details key={tp} open={active} className="group">
                    <summary
                      className={`cat-menu-btn flex cursor-pointer list-none items-center gap-1 rounded-xl border border-zinc-800 px-2.5 py-2.5 text-xs [&::-webkit-details-marker]:hidden lg:gap-2.5 lg:px-3 lg:text-sm ${active ? "active" : ""}`}
                    >
                      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ring-1 lg:h-8 lg:w-8 ${st.tile}`}>
                        <TypeIcon type={tp} className="h-4 w-4" />
                      </span>
                      <span className="flex-1 truncate">{st.label[zh ? "zh" : "en"]}</span>
                      <span className="shrink-0 rounded-full bg-zinc-800 px-1 py-0.5 text-xs tabular-nums text-zinc-400 lg:px-2 lg:text-xs">
                        {facetCounts[tp]?.total ?? 0}
                      </span>
                      <svg
                        viewBox="0 0 24 24"
                        className="h-3 w-3 shrink-0 text-zinc-500 transition-transform group-open:rotate-180 lg:h-3.5 lg:w-3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </summary>
                    <div className="mt-1.5 flex flex-wrap gap-1.5 rounded-xl border border-zinc-800/80 bg-zinc-950/40 p-2">
                      <Link
                        href={qs({ type: tp, category: "" })}
                        className={`cat-menu-btn rounded-full px-2.5 py-1 text-xs ${active && !category ? "active" : ""}`}
                      >
                        {zh ? "全部" : "All"}
                      </Link>
                      {subs.map((c) => {
                        const sel = active && category === c.slug;
                        const n = facetCounts[tp]?.subs?.[c.slug] ?? 0;
                        return (
                          <Link
                            key={c.slug}
                            href={qs({ type: tp, category: c.slug })}
                            className={`cat-menu-btn rounded-full px-2.5 py-1 text-xs ${sel ? "active" : ""}`}
                          >
                            {zh ? c.name : c.nameEn}
                            {n > 0 && <span className="ml-1 text-xs tabular-nums opacity-70">{n}</span>}
                          </Link>
                        );
                      })}
                    </div>
                  </details>
                );
              })}
            </div>
          </div>
        </aside>

        {/* 结果列表 */}
        <section className="min-w-0 flex-1">
          {error && (
            <div className="mb-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>
          )}

          {!q ? (
            <div className="relative overflow-hidden rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-16 text-center">
              <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-emerald-500/10 to-transparent" />
              <svg viewBox="0 0 24 24" className="mx-auto h-12 w-12 text-emerald-300/70" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.8-3.8" />
              </svg>
              <p className="mt-4 text-zinc-300">{t(locale, "search.empty")}</p>
              <p className="mt-1.5 text-xs text-zinc-500">
                {zh ? "试试「赛博朋克」「分镜」「AI 智能体」…" : "Try “cyberpunk”, “storyboard”, “AI agent”…"}
              </p>
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 px-6 py-14 text-center">
              <p className="text-zinc-200">{t(locale, "search.noresult")}</p>
              {activeCount > 0 && (
                <Link href={qs({ type: "", category: "" })} className="mt-3 inline-flex items-center gap-1 text-sm text-emerald-300 transition hover:text-emerald-200">
                  {zh ? "在全部类型中再找找" : "Search in all types"}
                </Link>
              )}
            </div>
          ) : (
            <>
              <ol className="space-y-3">
                {rows.map((r, i) => {
                  const st = TYPE_STYLE[r.tp];
                  const catName = r.catSlug ? catNameOf(r.tp, r.catSlug) : "";
                  return (
                    <li key={r.key}>
                      <Link
                        href={hrefOf(r)}
                        style={{ animation: `riseIn 0.45s ease both`, animationDelay: `${Math.min(i, 11) * 40}ms` }}
                        className="group relative flex gap-3.5 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 transition hover:-translate-y-0.5 hover:border-emerald-400/40 hover:shadow-[0_12px_40px_-12px_rgba(56,189,248,0.4)]"
                      >
                        <span aria-hidden className={`absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b ${st.accent}`} />
                        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ring-1 ${st.tile}`}>
                          <TypeIcon type={r.tp} className="h-5 w-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug text-zinc-100 transition group-hover:text-white">
                            <Marked text={r.title} />
                          </h3>
                          {r.desc && (
                            <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-zinc-400">
                              <Marked text={r.desc} />
                            </p>
                          )}
                          <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs">
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ring-1 ${st.badge}`}>
                              <TypeIcon type={r.tp} className="h-3 w-3" />
                              {st.label[zh ? "zh" : "en"]}
                            </span>
                            {catName && <span className="rounded-full bg-zinc-800/80 px-2 py-0.5 text-zinc-400">{catName}</span>}
                            <span className="inline-flex items-center gap-1 text-zinc-500">
                              <EyeIcon className="h-3.5 w-3.5" />
                              <span className="tabular-nums">{r.viewCount}</span>
                            </span>
                            <span className="ml-auto text-zinc-500">{fmtDate(r.ts, locale)}</span>
                          </div>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ol>
              <Pagination page={page} totalPages={totalPages} basePath="/search" query={{ q, type, category, sort }} />
            </>
          )}
        </section>
      </div>
    </main>
  );
}
