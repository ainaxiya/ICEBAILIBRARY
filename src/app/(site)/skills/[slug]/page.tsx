import Link from "next/link";
import type { CSSProperties } from "react";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser, getCurrentAdmin } from "@/lib/auth";
import { getServerLocale } from "@/lib/i18n";
import { safeJsonScript } from "@/lib/rich";
import { metaDescription, breadcrumbJsonLd, siteUrl } from "@/lib/seo";
import { getSettings } from "@/lib/settings";
import { COMMENT } from "@/lib/comment-policy";
import CommentSection, { type CommentData } from "@/components/CommentSection";
import SkillActions from "@/components/SkillActions";
import FavoriteButton from "@/components/FavoriteButton";
import { skillHref } from "@/lib/skill-link";

export const dynamic = "force-dynamic";

type FileEntry = { path: string; content: string; size?: number };

// 分类配色（面包屑按钮 + 相关技能发光色共用）：按分类名关键词匹配，与技能列表页一致
const CAT_THEME: [RegExp, { badge: string; glow: string }][] = [
  [/智能体|agent/i, { badge: "bg-violet-500/15 text-violet-300", glow: "139 92 246" }],
  [/写作|writing|办公/i, { badge: "bg-orange-500/15 text-orange-300", glow: "249 115 22" }],
  [/设计|design|创意/i, { badge: "bg-rose-500/15 text-rose-300", glow: "244 63 94" }],
  [/数据|data|分析/i, { badge: "bg-cyan-500/15 text-cyan-300", glow: "6 182 212" }],
  [/营销|marketing|运营/i, { badge: "bg-amber-500/15 text-amber-300", glow: "245 158 11" }],
  [/安全|security/i, { badge: "bg-red-500/15 text-red-300", glow: "239 68 68" }],
  [/科研|research|学术/i, { badge: "bg-teal-500/15 text-teal-300", glow: "20 184 166" }],
  [/提示词|prompt/i, { badge: "bg-fuchsia-500/15 text-fuchsia-300", glow: "217 70 239" }],
  [/编程|coding|program|开发/i, { badge: "bg-sky-500/15 text-sky-300", glow: "14 165 235" }],
];
const catTheme = (slug: string, name: string) => {
  const all = `${slug} ${name}`;
  for (const [re, t] of CAT_THEME) if (re.test(all)) return t;
  return { badge: "bg-zinc-700/40 text-zinc-300", glow: "56 189 248" };
};

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
    // 会员被删除后评论保留，作者为 null（前端显示「该会员号已注销」）
    user: c.user
      ? { id: c.user.id, username: c.user.username, nickname: c.user.nickname, avatar: c.user.avatar }
      : null,
    replies: ((c.replies ?? []) as any[]).map(serializeComment),
  };
}

// slug 允许重复：优先精确 slug 匹配（兼容旧链接，同 slug 取最新），
// 其次解析 `slug-id` 形式按 id 精确定位；一次性带出详情页所需 category
const SKILL_INCLUDE = { category: { select: { name: true, nameEn: true, slug: true, icon: true } } } as const;

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
    title: `${s.name} - AI技能`,
    description: metaDescription(s.summary, `${s.name}：可直接复制使用的 AI 技能（SKILL.md），含智能体工作流与使用说明。`),
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

  const rawFiles = (Array.isArray(skill.files) ? skill.files : []) as unknown as FileEntry[];
  // __bundle__ 哨兵（整包上传）不对外展示；下载时回传桶内原 zip 完整还原目录
  const files = rawFiles.filter((f) => f.path !== "__bundle__");

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
      select: { id: true, slug: true, name: true, summary: true, viewCount: true, copyCount: true, tags: true },
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
  const related = sameCat.sort(() => Math.random() - 0.5).slice(0, 8);
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
    dateModified: skill.updatedAt.toISOString(),
    mainEntityOfPage: siteUrl(skillHref(skill.slug, skill.id)),
  };
  const bcJsonLd = breadcrumbJsonLd([
    { name: "首页", item: siteUrl() },
    { name: "AI技能", item: siteUrl("/skills") },
    { name: skill.name, item: siteUrl(skillHref(skill.slug, skill.id)) },
  ]);

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
            <Link href={`/skills?cat=${skill.category.slug}`} className={`inline-flex items-center gap-1.5 rounded-lg border border-transparent px-2.5 py-1 text-sm font-medium transition hover:opacity-80 ${catTheme(skill.category.slug, skill.category.name).badge}`}>
              {locale === "zh" ? skill.category.name : skill.category.nameEn}
            </Link>
            {skill.status === "pending" && (
              <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">{locale === "zh" ? "待审核" : "Pending"}</span>
            )}
            {/* v0.117 会员收藏（星星胶囊款，第一排栏目行最右） */}
            <FavoriteButton type="skill" targetId={skill.id} size="sm" className="ml-auto" />
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
            <SkillActions skillId={skill.id} skillMd={skill.skillMd} hasFiles={rawFiles.length > 0} locale={locale} />
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
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500/30 to-violet-500/30 text-xs font-bold text-cyan-200">
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
            <p className="mt-3 border-t border-zinc-800/70 pt-2.5 text-xs text-zinc-500">
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
              <h3 className="mb-2 text-sm font-medium text-zinc-300">
                {locale === "zh" ? "Files in this skill" : "Files"} ({files.length})
              </h3>
              <p className="mb-3 text-xs leading-relaxed text-zinc-500">
                {locale === "zh"
                  ? "多文件技能请点「下载」获取整包 zip：解压即还原 SKILL.md 与全部分支目录（references/、scripts/ 等），可直接供 Claude Code / Codex 等本地 Agent 目录式加载。对话模型一键使用则直接复制 SKILL.md。"
                  : "For multi-file skills, download the bundle zip to restore SKILL.md plus all reference/script directories for local agents (Claude Code, Codex, etc.). For chat models, just copy SKILL.md."}
              </p>
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

          {/* 来源（纯文字，不带超链接） */}
          {(skill.sourceUrl || skill.sourceSite) && (
            <section className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400">
              <span className="text-zinc-500">{locale === "zh" ? "来源：" : "Source: "}</span>
              {skill.sourceSite || skill.sourceUrl}
            </section>
          )}

          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonScript(jsonLd) }} />
          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: bcJsonLd }} />
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

      {/* 右列：相关技能（随机 8 条，v0.93 完整卡片） */}
      <aside className="w-full shrink-0 space-y-4 self-start lg:w-[300px]">
        <h3 className="text-sm font-medium text-zinc-400">
          {locale === "zh" ? "相关技能" : "Related Skills"}
          <span className="ml-1.5 text-xs font-normal text-zinc-600">{locale === "zh" ? "随机 8 条" : "8 random"}</span>
        </h3>
        {related.length === 0 && <p className="text-xs text-zinc-600">{locale === "zh" ? "暂无" : "None"}</p>}
        {related.map((r) => {
          const th = catTheme(skill.category.slug, skill.category.name);
          return (
            <Link
              key={r.id}
              href={skillHref(r.slug, r.id)}
              style={{ "--glow-rgb": th.glow } as CSSProperties}
              className="skill-glow group flex flex-col rounded-2xl border bg-gradient-to-b from-zinc-900/90 to-zinc-950/90 p-4 transition hover:shadow-xl hover:shadow-zinc-950/60"
            >
              <div className="mb-3">
                <h4 className="skill-title line-clamp-2 font-semibold leading-snug text-zinc-50" title={r.name}>{r.name}</h4>
                <div className="mt-1.5 flex items-center gap-1.5 text-xs">
                  <span className="truncate text-zinc-500">{r.slug}</span>
                  <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium ${th.badge}`}>
                    {(skill.category as { icon?: string | null }).icon && <span className="mr-0.5">{(skill.category as { icon?: string | null }).icon}</span>}
                    {locale === "zh" ? skill.category.name : skill.category.nameEn}
                  </span>
                </div>
              </div>
              <div className="mb-2.5 rounded-xl bg-zinc-800/40 p-2.5">
                <p className="mb-1 text-xs font-medium text-zinc-400">📄 {locale === "zh" ? "说明" : "About"}</p>
                <p className="line-clamp-2 text-xs leading-relaxed text-zinc-300">{r.summary}</p>
              </div>
              {r.tags.length > 0 && (
                <div className="mb-2.5">
                  <p className="mb-1.5 text-xs font-medium text-zinc-400">🏷 {locale === "zh" ? "关联标签" : "Tags"}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {r.tags.map((tag) => (
                      <span key={tag} className={`rounded-md px-2 py-0.5 text-xs ${th.badge}`}>{tag}</span>
                    ))}
                  </div>
                </div>
              )}
              <div className="mt-auto flex items-center justify-between pt-1 text-xs text-zinc-500">
                <span>{locale === "zh" ? `复制使用 ≈ ${r.copyCount} 次` : `Used ≈ ${r.copyCount}x`}</span>
                <span className="inline-flex items-center gap-1">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  {r.viewCount >= 1000 ? `${(r.viewCount / 1000).toFixed(1)}k` : r.viewCount}
                </span>
              </div>
              <span className="mt-2.5 flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-[#2563eb] to-[#3b82f6] py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-600/25 transition group-hover:brightness-110">
                {locale === "zh" ? "查看技能" : "View Skill"}
              </span>
            </Link>
          );
        })}
      </aside>
    </div>
  );
}
