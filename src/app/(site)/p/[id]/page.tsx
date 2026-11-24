import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser, getCurrentAdmin } from "@/lib/auth";
import { CopyButton } from "@/components/Buttons";
import FavoriteButton from "@/components/FavoriteButton";
import PromptCard from "@/components/PromptCard";
import AutoTranslate from "@/components/AutoTranslate";
import MediaGallery, { SectionMedia } from "@/components/MediaGallery";
import ImageLightbox from "@/components/ImageLightbox";
import SingleVideoPlayback from "@/components/SingleVideoPlayback";
import RichVideoEnhancer from "@/components/media/RichVideoEnhancer";
import CategoryIcon from "@/components/CategoryIcon";
import { getServerLocale, translate as t } from "@/lib/i18n";
import { detectLang } from "@/lib/langdetect";
import type { MediaItem } from "@/lib/media";
import { isHtmlContent, stripHtml, safeJsonScript } from "@/lib/rich";
import { metaDescription, breadcrumbJsonLd, siteUrl } from "@/lib/seo";
import { sanitizeRich } from "@/lib/sanitize.server";
import { getCategoryMeta } from "@/lib/category-meta";
import { getSettings } from "@/lib/settings";
import { COMMENT } from "@/lib/comment-policy";
import CommentSection, { type CommentData } from "@/components/CommentSection";
import PromptToc from "@/components/PromptToc";

const COMMENT_PAGE_SIZE = COMMENT.PAGE_SIZE;

// 创作类型元信息：key → 中文标签 / 链接 slug / 图标 / 配色
const TYPE_META: Record<string, { zh: string; en: string; icon: string; cls: string }> = {
  text:  { zh: "文本创作", en: "Text",  icon: "📝", cls: "bg-sky-500/15 text-sky-300 border-sky-700/50" },
  image: { zh: "文生图",   en: "Image", icon: "🎨", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-700/50" },
  video: { zh: "文生视频", en: "Video", icon: "🎬", cls: "bg-violet-500/15 text-violet-300 border-violet-700/50" },
  audio: { zh: "文生音频", en: "Audio", icon: "🎵", cls: "bg-amber-500/15 text-amber-300 border-amber-700/50" },
};

export const dynamic = "force-dynamic";

// 将 Prisma Comment（含 Date 字段）序列化为可传给 client 组件的 plain object
// 富文本「本页结构」跳转锚点：在每个 [N] 分段标记前插入空锚点 span
// 锚点 id/序号与侧栏分段一一对应（最多注入 count 个，富文本内 [N] 数应与分段数一致）
function injectSegAnchors(html: string, count: number): string {
  let i = 0;
  return html.replace(/\[(\d+)\]/g, (m) =>
    i < count ? `<span id="seg-${i}" data-seg-index="${i++}" class="block h-1"></span>${m}` : m
  );
}

function serializeComment(c: any): CommentData {
  // 有公开回复的已删顶级评论：渲染占位
  if (c.status === "deleted") {
    return {
      id: c.id,
      targetType: c.targetType,
      targetId: c.targetId,
      parentId: null,
      status: "deleted",
      deleted: true,
      content: "",
      likeCount: 0,
      liked: false,
      createdAt: c.createdAt.toISOString(),
      user: null,
      replies: ((c.replies ?? []) as any[]).map(serializeComment),
    };
  }
  return {
    id: c.id,
    userId: c.userId,
    targetType: c.targetType,
    targetId: c.targetId,
    content: c.content,
    parentId: c.parentId,
    status: c.status,
    likeCount: c.likeCount,
    liked: Array.isArray(c.likes) ? c.likes.length > 0 : false,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    // 会员被删除后评论保留，作者为 null（前端显示「该会员号已注销」）
    user: c.user
      ? {
          id: c.user.id,
          username: c.user.username,
          nickname: c.user.nickname,
          avatar: c.user.avatar,
        }
      : null,
    replies: ((c.replies ?? []) as any[]).map(serializeComment),
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // 严格入参守卫：必须是正整数。不用 parseInt —— parseInt("123abc") 会得 123，
  // 把垃圾路径当成合法 id 去查库（线上曾因此产生 30 条 invalid id 报错）。
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) return {};
  const p = await db.prompt.findUnique({
    where: { id: pid },
    select: { title: true, description: true, tags: true, content: true, status: true },
  });
  if (!p) return { title: "未找到" };
  const desc = metaDescription(stripHtml(p.description || p.content || p.title));
  return {
    title: p.title,
    description: desc,
    keywords: p.tags,
    robots: p.status === "published" ? undefined : { index: false, follow: false },
  };
}

export default async function PromptDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // 与 generateMetadata 同一套严格校验：/p/123abc 这类路径直接 404，不落到 id=123
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) notFound();
  const locale = await getServerLocale();

  const [p, user, admin] = await Promise.all([
    db.prompt.findUnique({
      where: { id: pid },
      include: {
        user: { select: { id: true, username: true, nickname: true } },
      },
    }),
    getCurrentUser(),
    getCurrentAdmin(),
  ]);
  if (!p) notFound();

  // 未发布内容：仅作者本人或管理员可见
  const canSee =
    p.status === "published" || !!admin || (user && user.id === p.userId);
  if (!canSee) notFound();

  if (p.status === "published") {
    // 原生 SQL 自增，不触 updatedAt（避免 Meili 守护进程每次浏览都重复推送该文档）
    db.$executeRaw`UPDATE "Prompt" SET "viewCount" = "viewCount" + 1 WHERE id = ${pid}`.catch(() => {});
  }


  // 内容源语言：以入库语言为准，缺省时实时检测
  const sourceLang = p.language || detectLang(stripHtml(p.content));

  const isRich = isHtmlContent(p.content);
  // 富文本：消毒后整体渲染；旧纯文本：解析 [N] 分节
  const richHtml = isRich ? sanitizeRich(p.content) : "";
  const plainText = isRich ? stripHtml(p.content).trim() : "";

  // 解析提示词分节：[N] 标签行 -> 正文直到下一个 [N] 之前
  // 纯文本直接用原文解析；富文本用剥离 HTML 后的纯文本解析（富文本整体渲染，仅用分段提取标题/锚点）
  const sections: { no: number; label: string; body: string }[] = [];
  {
    const secText = isRich ? plainText : p.content;
    const re = /^\[(\d+)\]\s*(.+)$/gm;
    const marks: { idx: number; no: number; label: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(secText))) marks.push({ idx: m.index, no: +m[1], label: m[2] });
    for (let i = 0; i < marks.length; i++) {
      const nl = secText.indexOf("\n", marks[i].idx);
      const bodyStart = nl < 0 ? marks[i].idx : nl + 1;
      const end = i + 1 < marks.length ? marks[i + 1].idx : secText.length;
      sections.push({
        no: marks[i].no,
        label: marks[i].label,
        body: secText.slice(bodyStart, end).trim(),
      });
    }
    if (sections.length === 0) sections.push({ no: 0, label: "", body: secText.trim() });
  }

  // 「本页结构」分段导航：纯文本或富文本，只要分段 >=2 都显示侧栏
  const showToc = sections.length >= 2;
  const tocSegments = showToc
    ? sections.map((s, i) => ({ index: i, label: s.label || `第 ${i + 1} 段` }))
    : [];

  // 富文本分段跳转：在每个 [N] 标记前注入锚点 span（数量对齐侧栏分段数）
  const richHtmlWithSegs = isRich && showToc ? injectSegAnchors(richHtml, sections.length) : richHtml;

  // 相关推荐 + 热搜词 + 评论设置 + 首屏评论：互不依赖，全部并行
  const commentWhere = {
    targetType: "prompt",
    targetId: pid,
    parentId: null,
    OR: [
      { status: "published" },
      { status: "deleted", replies: { some: { status: "published" } } },
    ],
  };
  const likedSelect = user ? { likes: { where: { userId: user.id }, select: { id: true } } } : {};
  const [sameCatIds, tagRows, settings, [rawComments, commentTotal]] = await Promise.all([
    // 相关推荐候选：同分类已发布（排除自己），上限 200 条参与随机，避免大分类全量拉取
    db.prompt.findMany({
      where: { status: "published", id: { not: pid }, category: p.category },
      select: { id: true },
      take: 200,
    }),
    // 热搜词：从全站已发布提示词的 tags 中随机抽 15 个
    db.prompt.findMany({
      where: { status: "published", tags: { isEmpty: false } },
      select: { tags: true },
      take: 500,
    }),
    getSettings(),
    // 首屏评论（顶级 20 条，含已赞状态；有公开回复的已删评论显示占位）
    Promise.all([
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
        take: COMMENT_PAGE_SIZE,
      }),
      db.comment.count({ where: commentWhere }),
    ]),
  ]);

  // 相关推荐：候选中随机 10 条
  const shuffledIds = sameCatIds
    .map((r) => r.id)
    .sort(() => Math.random() - 0.5)
    .slice(0, 10);
  const relatedRaw = shuffledIds.length
    ? await db.prompt.findMany({
        where: { id: { in: shuffledIds } },
        select: {
          id: true, title: true, type: true, category: true, tags: true,
          sourceAuthor: true, viewCount: true, coverUrl: true, featured: true,
          description: true, content: true,
        },
      })
    : [];
  // 按洗牌后的 id 顺序输出，保证"随机感"
  const idOrder = new Map(shuffledIds.map((id, i) => [id, i]));
  const related = relatedRaw.sort(
    (a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0)
  );

  const tagSet = new Set<string>();
  tagRows.forEach((r) => r.tags.forEach((tg) => tagSet.add(tg)));
  const hotTags = [...tagSet].sort(() => Math.random() - 0.5).slice(0, 15);

  const comments = rawComments.map(serializeComment);
  const commentsClosed = !settings.comment.enabled || p.commentsClosed;

  const media = (Array.isArray(p.media) ? p.media : []) as unknown as MediaItem[];
  // 分段媒体：按 section 序号分组；其余（封面等）进顶部画廊
  const sectionMedia = new Map<number, MediaItem[]>();
  for (const m of media) {
    if (typeof m.section === "number") {
      const arr = sectionMedia.get(m.section) || [];
      arr.push(m);
      sectionMedia.set(m.section, arr);
    }
  }
  const topMedia = media.filter((m) => typeof m.section !== "number");

  const typeMeta = TYPE_META[p.type] || TYPE_META.text;
  const typeLabel = locale === "zh" ? typeMeta.zh : typeMeta.en;
  const catMeta = p.category ? getCategoryMeta(p.category) : null;
  const viewCount = p.viewCount + (p.status === "published" ? 1 : 0);
  const pubDate = (p.publishedAt || p.createdAt).toISOString().slice(0, 10);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: p.title,
    name: p.title,
    description: p.description || undefined,
    keywords: p.tags.join(","),
    author: { "@type": "Person", name: p.sourceAuthor || p.user?.nickname || p.user?.username || "该会员号已注销" },
    datePublished: p.createdAt.toISOString(),
    dateModified: p.updatedAt.toISOString(),
    mainEntityOfPage: siteUrl(`/p/${p.id}`),
  };
  const bcJsonLd = breadcrumbJsonLd([
    { name: "首页", item: siteUrl() },
    ...(p.category && catMeta
      ? [{ name: catMeta.name[locale], item: siteUrl(`/category/${encodeURIComponent(p.category)}`) }]
      : []),
    { name: p.title, item: siteUrl(`/p/${p.id}`) },
  ]);

  return (
    <>
    {/* 布局：桌面端左右两列 — 左列（面包屑+内容+热搜词+评论 连续堆叠），右列相关推荐；手机端同序堆叠 */}
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* 本页结构：分段目录（桌面吸顶侧栏；中小屏折为右下角小图标弹层） */}
      {showToc && <PromptToc segments={tocSegments} />}
      {/* 左列：内容主体 */}
      <div className="min-w-0 flex-1 space-y-6">
      <article className="self-start">
        <div className="mb-4">
          {/* 面包屑：栏目（可点进列表） + 创作类型（可点进类型列表） */}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            {p.category && catMeta && (
              <Link
                href={`/category/${encodeURIComponent(p.category)}`}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-medium transition hover:opacity-80 ${catMeta.bg} ${catMeta.fg} border-transparent`}
              >
                <CategoryIcon icon={catMeta.icon} className="h-4 w-4" />
                {catMeta.name[locale]}
              </Link>
            )}
            <Link
              href={`/type/${encodeURIComponent(p.type)}`}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-medium transition hover:opacity-80 ${typeMeta.cls}`}
            >
              <span>{typeMeta.icon}</span>
              {typeLabel}
            </Link>
            {p.featured && (
              <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300">★</span>
            )}
            {p.status === "pending" && (
              <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">
                {t(locale, "detail.pending")}
              </span>
            )}
            {p.status === "rejected" && (
              <span className="rounded bg-rose-500/15 px-2 py-0.5 text-xs text-rose-300">
                {t(locale, "detail.rejected")}
              </span>
            )}
            {/* v0.117 会员收藏（星星胶囊款，第一排栏目行最右） */}
            <FavoriteButton type="prompt" targetId={p.id} size="sm" className="ml-auto" />
          </div>
          <h1 className="mb-3 text-2xl font-bold leading-tight">{p.title}</h1>
          {/* 元信息：作者 / 发布日期 / 观看 / 赞 + 原作品链接 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-zinc-400">
            <span className="inline-flex items-center gap-1.5">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-zinc-500"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              {locale === "zh" ? "作者" : "Author"}：{p.sourceAuthor || p.user?.nickname || p.user?.username || "该会员号已注销"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-zinc-500"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
              {locale === "zh" ? "发布日期" : "Published"}：{pubDate}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-zinc-500"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              {locale === "zh" ? "观看" : "Views"}：{viewCount}
            </span>
          </div>
          {p.status === "rejected" && p.rejectReason && (
            <p className="mt-2 rounded border border-rose-800/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
              {t(locale, "detail.rejectReason")}：{p.rejectReason}
            </p>
          )}
          {p.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {p.tags.map((tag) => (
                <Link key={tag} href={`/search?q=${encodeURIComponent(tag)}`} className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400 hover:text-zinc-200">
                  #{tag}
                </Link>
              ))}
            </div>
          )}
        </div>

        <MediaGallery media={topMedia} />

        {p.description && (
          <p className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-sm leading-relaxed text-zinc-300">
            {p.description}
          </p>
        )}

        <div className="space-y-3">
          {isRich ? (
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 sm:p-4">
              <div className="mb-2 flex items-center justify-end gap-2">
                <CopyButton text={plainText} />
              </div>
              <div
                className="rich-content text-sm leading-relaxed text-zinc-300"
                dangerouslySetInnerHTML={{ __html: richHtmlWithSegs }}
              />
              <AutoTranslate text={plainText} source={sourceLang as "zh" | "en"} index={0} />
            </section>
          ) : (
            sections.map((s, i) => {
              const chips = s.label ? s.label.split("｜").filter(Boolean) : [];
              const secImgs = sectionMedia.get(s.no);
              return (
                <section key={i} id={`seg-${i}`} data-seg-index={i} className="scroll-mt-24 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-5">
                  <div className="mb-2.5 flex items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                      {/* 分段编号：01 / 11 两位数序号清晰标注 */}
                      <span className="font-mono text-lg font-bold leading-none text-emerald-300">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="font-mono text-xs text-zinc-600">
                        / {String(sections.length).padStart(2, "0")}
                      </span>
                      {chips.map((c, ci) => (
                        <span
                          key={ci}
                          className={
                            ci === chips.length - 1
                              ? "rounded border border-emerald-700/60 bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-300"
                              : "rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400"
                          }
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                    <CopyButton text={s.body} />
                  </div>
                  {secImgs && <SectionMedia items={secImgs} altBase={p.title} />}
                  <p className={`prompt-content whitespace-pre-wrap text-sm leading-relaxed text-zinc-300 ${secImgs ? "mt-3" : ""}`}>{s.body}</p>
                  <AutoTranslate text={s.body} source={sourceLang as "zh" | "en"} index={i} />
                </section>
              );
            })
          )}
        </div>

        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonScript(jsonLd) }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: bcJsonLd }} />
      </article>

      {/* 热搜词：紧随内容 */}
      {hotTags.length > 0 && (
        <section className="self-start rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300">
            <span className="text-orange-400">🔥</span>
            {locale === "zh" ? "热搜词" : "Trending"}
          </h3>
          <div className="flex flex-wrap gap-2">
            {hotTags.map((tag) => (
              <Link
                key={tag}
                href={`/search?q=${encodeURIComponent(tag)}`}
                className="rounded-full border border-zinc-700 bg-zinc-800/70 px-3 py-1 text-xs text-zinc-300 transition hover:border-emerald-500/60 hover:text-emerald-300"
              >
                #{tag}
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* 评论：紧随热搜词 */}
      <section className="self-start">
        <CommentSection
          targetType="prompt"
          targetId={pid}
          initialComments={comments}
          closed={commentsClosed}
          initialTotal={commentTotal}
        />
      </section>
      </div>

      {/* 右列：相关推荐 */}
      <aside className="w-full shrink-0 space-y-6 self-start lg:w-[280px]">
        <div>
          <h3 className="mb-3 text-sm font-medium text-zinc-400">{t(locale, "detail.related")}</h3>
          <div className="space-y-2">
            {related.map((r) => (
              <PromptCard key={r.id} p={r} locale={locale} />
            ))}
          </div>
        </div>
      </aside>
    </div>

    {/* 图片灯箱：拦截正文/画廊图片点击，本页放大显示 */}
    <ImageLightbox />
    {/* 同页视频互斥：开始播放某个视频时自动暂停其它视频 */}
    <SingleVideoPlayback />
    {/* 正文富文本里的原生 <video> 就地替换为统一播放器 */}
    <RichVideoEnhancer />
    </>
  );
}
