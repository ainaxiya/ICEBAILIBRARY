import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser, getCurrentAdmin } from "@/lib/auth";
import { getServerLocale } from "@/lib/i18n";
import { safeJsonScript } from "@/lib/rich";
import { getSettings } from "@/lib/settings";
import { COMMENT } from "@/lib/comment-policy";
import CommentSection, { type CommentData } from "@/components/CommentSection";
import SkillActions from "@/components/SkillActions";
import { skillHref } from "@/lib/skill-link";

export const dynamic = "force-dynamic";

type FileEntry = { path: string; content: string; size?: number };

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

// slug 允许重复：优先精确 slug 匹配（兼容旧链接，同 slug 取最新），
// 其次解析 `slug-id` 形式按 id 精确定位；一次性带出详情页所需 category
const SKILL_INCLUDE = { category: { select: { name: true, nameEn: true, slug: true } } } as const;

async function resolveSkill(param: string) {
  const bySlug = await db.skill.findFirst({ where: { slug: param }, orderBy: { id: "desc" }, include: SKILL_INCLUDE });
  if (bySlug) return bySlug;
  const m = param.match(/^(.+)-(\d+)$/);
  if (m) {
    const byId = await db.skill.findUnique({ where: { id: Number(m[2]) }, include: SKILL_INCLUDE });
    if (byId && byId.slug === m[1]) return byId;
  }
  return null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await resolveSkill(slug).then((r) =>
    r ? { name: r.name, summary: r.summary, tags: r.tags, status: r.status } : null
  );
  if (!s) return { title: "未找到" };
  return {
    title: s.name,
    description: s.summary.slice(0, 200),
    keywords: s.tags,
    robots: s.status === "published" ? undefined : { index: false, follow: false },
  };
}

export default async function SkillDetail({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const locale = await getServerLocale();
  const [skill, admin, user] = await Promise.all([
    resolveSkill(slug),
    getCurrentAdmin(),
    getCurrentUser(),
  ]);
  if (!skill) notFound();
  if (skill.status !== "published" && !admin) notFound();

  // 浏览量 +1：原生 SQL 自增，不触 updatedAt（避免 Meili 重复推送）
  if (skill.status === "published") {
    db.$executeRaw`UPDATE "Skill" SET "viewCount" = "viewCount" + 1 WHERE id = ${skill.id}`.catch(() => {});
  }

  const files = (Array.isArray(skill.files) ? skill.files : []) as unknown as FileEntry[];

  // 相关技能 + 评论设置 + 评论列表/总数：互不依赖，并行发起
  const commentWhere = {
    targetType: "skill",
    targetId: skill.id,
    parentId: null,
    OR: [
      { status: "published" },
      { status: "deleted", replies: { some: { status: "published" } } },
    ],
  };
  const likedSelect = user ? { likes: { where: { userId: user.id }, select: { id: true } } } : {};
  const [sameCat, settings, rawComments, commentTotal] = await Promise.all([
    db.skill.findMany({
      where: { status: "published", id: { not: skill.id }, categoryId: skill.categoryId },
      select: { id: true, slug: true, name: true, summary: true, viewCount: true, copyCount: true },
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

  const viewCount = skill.viewCount + (skill.status === "published" ? 1 : 0);
  const pubDate = (skill.publishedAt || skill.createdAt).toISOString().slice(0, 10);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    name: skill.name,
    description: skill.summary,
    keywords: skill.tags.join(","),
    author: skill.author ? { "@type": "Person", name: skill.author } : undefined,
    datePublished: (skill.publishedAt || skill.createdAt).toISOString(),
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* 左列：主体 */}
      <div className="min-w-0 flex-1 space-y-6">
        <article className="self-start">
          {/* 面包屑 */}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <Link href="/skills" className="inline-flex items-center gap-1.5 rounded-lg border border-transparent bg-emerald-500/15 px-2.5 py-1 text-sm font-medium text-emerald-300 transition hover:opacity-80">
              🧩 {locale === "zh" ? "AI 技能" : "AI Skills"}
            </Link>
            <Link href={`/skills?cat=${skill.category.slug}`} className="inline-flex items-center gap-1.5 rounded-lg border border-transparent bg-zinc-700/40 px-2.5 py-1 text-sm font-medium text-zinc-300 transition hover:opacity-80">
              {locale === "zh" ? skill.category.name : skill.category.nameEn}
            </Link>
            {skill.status === "pending" && (
              <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">{locale === "zh" ? "待审核" : "Pending"}</span>
            )}
          </div>

          <h1 className="mb-3 text-2xl font-bold leading-tight">{skill.name}</h1>

          {/* 元信息 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-zinc-400">
            {skill.author && (
              <span className="inline-flex items-center gap-1.5">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-zinc-500"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                {skill.author}
              </span>
            )}
            {skill.version && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">v{skill.version}</span>}
            {skill.license && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">{skill.license}</span>}
            <span className="inline-flex items-center gap-1.5">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-zinc-500"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
              {pubDate}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-zinc-500"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              {locale === "zh" ? "查看" : "Views"} {viewCount}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-zinc-500"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              {locale === "zh" ? "复制" : "Copies"} {skill.copyCount}
            </span>
          </div>

          {skill.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {skill.tags.map((tag) => (
                <Link key={tag} href={`/search?q=${encodeURIComponent(tag)}`} className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400 hover:text-zinc-200">
                  #{tag}
                </Link>
              ))}
            </div>
          )}

          {/* 触发语 */}
          <p className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-sm leading-relaxed text-zinc-300">
            {skill.summary}
          </p>

          {/* 操作 */}
          <div className="mt-4">
            <SkillActions skillId={skill.id} skillMd={skill.skillMd} hasFiles={files.length > 0} locale={locale} />
          </div>

          {/* 通用技能使用教程 */}
          <section className="mt-4 rounded-2xl border border-cyan-800/40 bg-gradient-to-br from-cyan-950/40 via-zinc-900/60 to-violet-950/30 p-5">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-cyan-200">
              <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-cyan-500/20 text-xs">📘</span>
              {locale === "zh" ? "如何使用这个技能" : "How to use this skill"}
            </h3>
            <ol className="space-y-2.5 text-xs leading-relaxed text-zinc-300">
              {(locale === "zh"
                ? [
                    ["复制技能内容", "点击上方「Copy SKILL.md」复制全部内容，或 Download 下载到本地"],
                    ["打开你的 AI 客户端", "支持 Claude Code、Trae、Cursor、ChatGPT、DeepSeek、Kimi 等任意 AI 助手"],
                    ["粘贴为系统提示/知识文件", "Claude Code：放入 .claude/skills/ 目录；普通对话：作为首条消息发送并说「请严格按这份技能文档执行」"],
                    ["直接提出你的需求", "AI 会按技能定义的工作流、格式和约束来处理，无需再解释背景"],
                  ]
                : [
                    ["Copy the skill", "Click “Copy SKILL.md” above, or Download it to your machine"],
                    ["Open your AI client", "Works with Claude Code, Trae, Cursor, ChatGPT, DeepSeek, Kimi and more"],
                    ["Paste as system prompt / knowledge file", "Claude Code: place in .claude/skills/; plain chat: send it as the first message with “follow this skill doc strictly”"],
                    ["State your need directly", "The AI will follow the workflow, format and constraints defined in the skill"],
                  ]
              ).map(([title, desc], i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500/30 to-violet-500/30 text-[10px] font-bold text-cyan-200">
                    {i + 1}
                  </span>
                  <div>
                    <span className="font-medium text-zinc-100">{title}</span>
                    <span className="mx-1.5 text-zinc-600">·</span>
                    <span className="text-zinc-400">{desc}</span>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-3 border-t border-zinc-800/70 pt-2.5 text-[11px] text-zinc-500">
              {locale === "zh"
                ? "💡 提示：技能生效后，每次对话只需一句需求，AI 会按 SKILL.md 的流程执行。"
                : "💡 Tip: once loaded, a single instruction is enough — the AI follows SKILL.md's workflow."}
            </p>
          </section>

          {/* SKILL.md 展示：等宽字体 + 固定最大高度 + 内部滚动 */}
          <section className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/80">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
              <span className="font-mono text-xs text-zinc-400">SKILL.md</span>
              <span className="text-xs text-zinc-600">{skill.skillMd.length} chars</span>
            </div>
            <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-zinc-300">{skill.skillMd}</pre>
          </section>

          {/* 附加文件清单 */}
          {files.length > 0 && (
            <section className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
              <h3 className="mb-3 text-sm font-medium text-zinc-300">
                {locale === "zh" ? "Files in this skill" : "Files"} ({files.length})
              </h3>
              <ul className="space-y-1.5 font-mono text-xs text-zinc-400">
                {files.map((f, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 rounded bg-zinc-800/50 px-2.5 py-1.5">
                    <span className="truncate">📄 {f.path}</span>
                    <span className="shrink-0 text-zinc-600">{(f.size ?? f.content.length) > 1024 ? `${((f.size ?? f.content.length) / 1024).toFixed(1)} KB` : `${f.size ?? f.content.length} B`}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* 来源 */}
          {(skill.sourceUrl || skill.sourceSite) && (
            <section className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400">
              <span className="text-zinc-500">{locale === "zh" ? "来源：" : "Source: "}</span>
              {skill.sourceUrl ? (
                <a href={skill.sourceUrl} target="_blank" rel="noopener nofollow" className="text-emerald-400 hover:underline">
                  {skill.sourceSite || skill.sourceUrl}
                </a>
              ) : (
                skill.sourceSite
              )}
            </section>
          )}

          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonScript(jsonLd) }} />
        </article>

        {/* 评论 */}
        <section className="self-start">
          <CommentSection
            targetType="skill"
            targetId={skill.id}
            initialComments={comments}
            closed={commentsClosed}
            initialTotal={commentTotal}
          />
        </section>
      </div>

      {/* 右列：相关技能 */}
      <aside className="w-full shrink-0 space-y-3 self-start lg:w-[280px]">
        <h3 className="text-sm font-medium text-zinc-400">{locale === "zh" ? "相关技能" : "Related Skills"}</h3>
        {related.length === 0 && <p className="text-xs text-zinc-600">{locale === "zh" ? "暂无" : "None"}</p>}
        {related.map((r) => (
          <Link
            key={r.id}
            href={skillHref(r.slug, r.id)}
            className="block rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 transition hover:border-emerald-700/60"
          >
            <div className="mb-1 truncate text-sm font-medium text-zinc-200">{r.name}</div>
            <p className="mb-2 line-clamp-2 text-xs text-zinc-500">{r.summary}</p>
            <div className="text-[11px] text-zinc-600">查看 {r.viewCount} · 复制 {r.copyCount}</div>
          </Link>
        ))}
      </aside>
    </div>
  );
}
