import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser, getCurrentAdmin } from "@/lib/auth";
import { getServerLocale } from "@/lib/i18n";
import { safeJsonScript } from "@/lib/rich";
import { getSettings } from "@/lib/settings";
import { COMMENT } from "@/lib/comment-policy";
import CommentSection, { type CommentData } from "@/components/CommentSection";
import SoftwareDownloadButtons from "@/components/SoftwareDownloadButtons";

export const dynamic = "force-dynamic";

function serializeComment(c: any): CommentData {
  if (c.status === "deleted") {
    return {
      id: c.id, targetType: c.targetType, targetId: c.targetId, parentId: null,
      status: "deleted", deleted: true, content: "", likeCount: 0, liked: false,
      createdAt: c.createdAt.toISOString(), user: null,
      replies: ((c.replies ?? []) as any[]).map(serializeComment),
    };
  }
  return {
    id: c.id, userId: c.userId, targetType: c.targetType, targetId: c.targetId,
    content: c.content, parentId: c.parentId, status: c.status, likeCount: c.likeCount,
    liked: Array.isArray(c.likes) ? c.likes.length > 0 : false,
    createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
    user: { id: c.user.id, username: c.user.username, nickname: c.user.nickname, avatar: c.user.avatar },
    replies: ((c.replies ?? []) as any[]).map(serializeComment),
  };
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await db.software.findUnique({
    where: { slug },
    select: { name: true, tagline: true, tags: true, status: true, icon: true },
  });
  if (!s) return { title: "未找到" };
  return {
    title: s.name,
    description: (s.tagline || "").slice(0, 200),
    keywords: s.tags,
    robots: s.status === "published" ? undefined : { index: false, follow: false },
  };
}

export default async function SoftwareDetail({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const locale = await getServerLocale();
  const [soft, admin, user] = await Promise.all([
    db.software.findUnique({
      where: { slug },
      include: {
        category: { select: { name: true, nameEn: true, slug: true, icon: true } },
        downloads: { orderBy: [{ sort: "asc" }, { id: "asc" }] },
      },
    }),
    getCurrentAdmin(),
    getCurrentUser(),
  ]);
  if (!soft) notFound();
  if (soft.status !== "published" && !admin) notFound();

  // 浏览量 +1：原生 SQL 自增，不触 updatedAt（避免 Meili 重复推送）
  if (soft.status === "published") {
    db.$executeRaw`UPDATE "Software" SET "viewCount" = "viewCount" + 1 WHERE id = ${soft.id}`.catch(() => {});
  }

  // 相关软件 + 评论设置 + 评论列表/总数：互不依赖，并行发起
  const commentWhere = {
    targetType: "software",
    targetId: soft.id,
    parentId: null,
    OR: [
      { status: "published" },
      { status: "deleted", replies: { some: { status: "published" } } },
    ],
  };
  const likedSelect = user ? { likes: { where: { userId: user.id }, select: { id: true } } } : {};
  const [sameCat, settings, rawComments, commentTotal] = await Promise.all([
    db.software.findMany({
      where: { status: "published", id: { not: soft.id }, categoryId: soft.categoryId },
      select: { id: true, slug: true, name: true, version: true, tagline: true, icon: true, viewCount: true, downloadCount: true },
      take: 30,
    }),
    getSettings(),
    db.comment.findMany({
      where: commentWhere,
      include: {
        user: { select: { id: true, username: true, nickname: true, avatar: true } },
        ...likedSelect,
        replies: {
          include: {
            user: { select: { id: true, username: true, nickname: true, avatar: true } },
            ...likedSelect,
          },
          where: { status: "published" },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
      take: COMMENT.PAGE_SIZE,
    }),
    db.comment.count({ where: commentWhere }),
  ]);
  const related = sameCat.sort(() => Math.random() - 0.5).slice(0, 6);
  const comments = rawComments.map(serializeComment);
  const commentsClosed = !settings.comment.enabled;

  const viewCount = soft.viewCount + (soft.status === "published" ? 1 : 0);
  const pubDate = (soft.publishedAt || soft.createdAt).toISOString().slice(0, 10);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: soft.name,
    description: soft.tagline || undefined,
    softwareVersion: soft.version || undefined,
    applicationCategory: soft.category.nameEn,
    operatingSystem: soft.platform || undefined,
    datePublished: (soft.publishedAt || soft.createdAt).toISOString(),
    interactionStatistic: {
      "@type": "InteractionCounter",
      interactionType: "https://schema.org/DownloadAction",
      userInteractionCount: soft.downloadCount,
    },
  };

  const infoItems: [string, string | null, string][] = [
    [locale === "zh" ? "版本" : "Version", soft.version ? `v${soft.version}` : null, "📦"],
    [locale === "zh" ? "体积" : "Size", soft.sizeText, "💾"],
    [locale === "zh" ? "平台" : "Platform", soft.platform, "🖥"],
    [locale === "zh" ? "语言" : "Language", soft.language, "🌐"],
  ];
  const shownInfo = infoItems.filter(([, v]) => v);

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* 左列：主体 */}
      <div className="min-w-0 flex-1 space-y-6">
        <article className="self-start">
          {/* 面包屑 */}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <Link href="/software" className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-2.5 py-1 text-sm font-medium text-emerald-300 transition hover:opacity-80">
              💾 {locale === "zh" ? "AI 软件" : "AI Software"}
            </Link>
            <Link href={`/software?cat=${soft.category.slug}`} className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500/15 px-2.5 py-1 text-sm font-medium text-sky-300 transition hover:opacity-80">
              {(soft.category as any).icon && <span>{(soft.category as any).icon}</span>}
              {locale === "zh" ? soft.category.name : soft.category.nameEn}
            </Link>
            {soft.status === "pending" && (
              <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">{locale === "zh" ? "待审核" : "Pending"}</span>
            )}
          </div>

          {/* Hero：图标 + 名称 + 简介 + 元信息 */}
          <div className="rounded-2xl border border-sky-800/40 bg-gradient-to-br from-sky-500/10 via-zinc-900/80 to-violet-500/10 p-5 shadow-xl shadow-sky-950/20">
            <div className="flex items-start gap-4">
              {soft.icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={soft.icon} alt={soft.name} className="h-24 w-24 shrink-0 rounded-3xl border border-zinc-700/60 object-cover shadow-2xl shadow-sky-950/50 ring-2 ring-sky-500/30" />
              ) : (
                <span className="grid h-24 w-24 shrink-0 place-items-center rounded-3xl bg-gradient-to-br from-sky-500/40 to-violet-500/40 text-4xl font-bold text-white shadow-2xl ring-2 ring-sky-500/30">
                  {(soft.category as any).icon || soft.name.slice(0, 1)}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold leading-tight text-zinc-50">
                  {soft.name}
                  {soft.version && <span className="rounded-md bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-300">v{soft.version}</span>}
                </h1>
                {soft.tagline && <p className="mt-1.5 text-sm text-zinc-300">{soft.tagline}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800/70 px-2.5 py-1 text-zinc-300">📅 {pubDate}</span>
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800/70 px-2.5 py-1 text-zinc-300">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 text-zinc-500"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    {viewCount}
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800/70 px-2.5 py-1 text-zinc-300">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 text-zinc-500"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    {soft.downloadCount}
                  </span>
                  {soft.officialUrl && (
                    <a href={soft.officialUrl} target="_blank" rel="noopener nofollow" className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 px-2.5 py-1 font-medium text-emerald-300 transition hover:opacity-80">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                      {locale === "zh" ? "官方网站" : "Official"}
                    </a>
                  )}
                </div>
              </div>
            </div>
            {soft.tags.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5 border-t border-zinc-800/60 pt-3.5">
                {soft.tags.map((tag) => (
                  <Link key={tag} href={`/search?q=${encodeURIComponent(tag)}`} className="rounded-md bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300 transition hover:bg-sky-500/20">
                    #{tag}
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* 下载方式 */}
          {soft.downloads.length > 0 && (
            <div className="mt-4 rounded-2xl border border-emerald-800/40 bg-gradient-to-br from-emerald-950/50 via-zinc-900/70 to-teal-950/40 p-4 shadow-lg shadow-emerald-950/20">
              <div className="mb-3 flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-emerald-500/20 text-sm text-emerald-300">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </span>
                <span className="text-sm font-semibold text-emerald-300">{locale === "zh" ? "下载方式" : "Download"}</span>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">{soft.downloads.length}</span>
              </div>
              <SoftwareDownloadButtons
                softwareId={soft.id}
                loggedIn={!!user}
                downloads={soft.downloads.map((d) => ({
                  id: d.id, label: d.label, memberOnly: d.memberOnly,
                  sizeBytes: d.sizeBytes != null ? Number(d.sizeBytes) : null,
                  storageType: d.storageType,
                }))}
              />
            </div>
          )}

          {/* 信息网格 */}
          {shownInfo.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {shownInfo.map(([k, v, icon], idx) => {
                const chipCls = ["text-sky-300", "text-violet-300", "text-amber-300", "text-teal-300"][idx % 4];
                return (
                  <div key={k} className="rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900/80 to-zinc-950/80 px-3 py-2.5">
                    <div className="text-[11px] text-zinc-500">{icon} {k}</div>
                    <div className={`mt-1 truncate text-sm font-semibold ${chipCls}`} title={v || ""}>{v}</div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 软件介绍（富文本，保存时已 sanitize） */}
          <section className="mt-4 rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900/70 to-zinc-950/70 p-5">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-violet-500/20 text-sm">📝</span>
              {locale === "zh" ? "软件介绍" : "About"}
            </h2>
            <div className="rich-content text-sm leading-relaxed text-zinc-300" dangerouslySetInnerHTML={{ __html: soft.description }} />
          </section>

          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonScript(jsonLd) }} />
        </article>

        {/* 评论 */}
        <section className="self-start">
          <CommentSection
            targetType="software"
            targetId={soft.id}
            initialComments={comments}
            closed={commentsClosed}
            initialTotal={commentTotal}
          />
        </section>
      </div>

      {/* 右列：相关软件 */}
      <aside className="w-full shrink-0 space-y-3 self-start lg:w-[280px]">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
          <span className="grid h-6 w-6 place-items-center rounded-lg bg-amber-500/20 text-xs">🧩</span>
          {locale === "zh" ? "相关软件" : "Related Software"}
        </h3>
        {related.length === 0 && <p className="text-xs text-zinc-600">{locale === "zh" ? "暂无" : "None"}</p>}
        {related.map((r) => (
          <Link
            key={r.id}
            href={`/software/${r.slug}`}
            className="group flex items-center gap-2.5 rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900/70 to-zinc-950/70 p-3 transition hover:border-sky-600/60 hover:shadow-lg"
          >
            {r.icon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={r.icon} alt="" className="h-10 w-10 shrink-0 rounded-xl border border-zinc-700/60 object-cover" />
            ) : (
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sky-500/15 text-sm text-sky-300">
                {r.name.slice(0, 1)}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-zinc-100 group-hover:text-white">
                {r.name}
                {r.version && <span className="ml-1 text-[10px] text-zinc-500">v{r.version}</span>}
              </div>
              {r.tagline && <div className="mt-0.5 truncate text-[11px] text-zinc-500">{r.tagline}</div>}
              <div className="mt-0.5 text-[11px] text-zinc-600">查看 {r.viewCount} · 下载 {r.downloadCount}</div>
            </div>
          </Link>
        ))}
      </aside>
    </div>
  );
}
