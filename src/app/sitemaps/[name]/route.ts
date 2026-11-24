import { db } from "@/lib/db";
import { skillHref } from "@/lib/skill-link";
import { CATEGORY_META } from "@/lib/category-meta";

export const revalidate = 3600;

// ─── sitemap 瘦身（v0.97）：与 /sitemap.xml 索引保持同一套上限 ───
const CHUNK = 5000;
const PROMPT_CAP = 10000;
const SKILL_CAP = 5000;

// 栏目页路由 slug（与 (site)/category/[slug]、(site)/type/[type] 一致）
const TYPE_SLUGS = ["text", "image", "video", "audio"];

type Entry = { loc: string; lastmod?: Date; priority: number; changefreq: string };

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function urlset(entries: Entry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map((e) =>
      [
        "  <url>",
        `    <loc>${xmlEscape(e.loc)}</loc>`,
        e.lastmod ? `    <lastmod>${e.lastmod.toISOString()}</lastmod>` : "",
        `    <changefreq>${e.changefreq}</changefreq>`,
        `    <priority>${e.priority}</priority>`,
        "  </url>",
      ]
        .filter(Boolean)
        .join("\n")
    ),
    "</urlset>",
  ].join("\n");
}

function xmlResponse(xml: string) {
  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}

// 内容排序：精选优先 → 发布时间新→旧（NULL 沉底）→ id 兜底（与列表页排序一致，保证分片稳定）
const contentOrderBy = [
  { publishedAt: { sort: "desc" as const, nulls: "last" as const } },
  { id: "desc" as const },
];

// 子 sitemap 分片：static / featured / prompts-N / skills-N（由 /sitemap.xml 索引；v0.117 software 已下线）
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name: rawName } = await params;
  // URL 形如 /sitemaps/prompts-0.xml，剥掉 .xml 后缀
  const name = rawName.replace(/\.xml$/, "");
  const base = (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");

  if (name === "static") {
    // 栏目页放前面：首页 → 分类/类型栏目 → 内容列表 → 站务单页
    const paths: { path: string; priority: number; changefreq: string }[] = [
      { path: "", priority: 1, changefreq: "hourly" },
      { path: "/categories", priority: 0.9, changefreq: "daily" },
      { path: "/category/all", priority: 0.9, changefreq: "daily" },
      ...Object.keys(CATEGORY_META).map((slug) => ({
        path: `/category/${slug}`,
        priority: 0.9,
        changefreq: "daily",
      })),
      ...TYPE_SLUGS.map((t) => ({ path: `/type/${t}`, priority: 0.9, changefreq: "daily" })),
      { path: "/skills", priority: 0.7, changefreq: "daily" },
      { path: "/playground", priority: 0.6, changefreq: "weekly" },
      // 固定站务单页（帮助/关于/联系/条款/隐私）
      { path: "/help", priority: 0.3, changefreq: "monthly" },
      { path: "/about", priority: 0.3, changefreq: "monthly" },
      { path: "/contact", priority: 0.3, changefreq: "monthly" },
      { path: "/terms", priority: 0.3, changefreq: "monthly" },
      { path: "/privacy", priority: 0.3, changefreq: "monthly" },
    ];
    return xmlResponse(
      urlset(paths.map((p) => ({ loc: base + p.path, priority: p.priority, changefreq: p.changefreq })))
    );
  }

  if (name === "featured") {
    // 精选内容置前（提示词在前、技能在后）
    const [prompts, skills] = await Promise.all([
      db.prompt.findMany({
        where: { status: "published", featured: true },
        select: { id: true, updatedAt: true },
        orderBy: contentOrderBy,
        take: CHUNK,
      }),
      db.skill.findMany({
        where: { status: "published", featured: true },
        select: { slug: true, id: true, updatedAt: true },
        orderBy: contentOrderBy,
        take: CHUNK,
      }),
    ]);
    return xmlResponse(
      urlset([
        ...prompts.map((p) => ({
          loc: `${base}/p/${p.id}`,
          lastmod: p.updatedAt,
          priority: 0.9,
          changefreq: "weekly",
        })),
        ...skills.map((s) => ({
          loc: base + skillHref(s.slug, s.id),
          lastmod: s.updatedAt,
          priority: 0.9,
          changefreq: "weekly",
        })),
      ])
    );
  }

  // v0.117 AI 软件下线：software sitemap 不再输出（旧 URL 已 301 到 /playground）

  const m = /^(prompts|skills)-(\d+)$/.exec(name);
  if (m) {
    const isPrompts = m[1] === "prompts";
    const cap = isPrompts ? PROMPT_CAP : SKILL_CAP;
    const offset = Number(m[2]) * CHUNK;
    if (m[2] === "" || Number.isNaN(offset) || offset < 0 || offset >= cap) {
      return new Response("Not found", { status: 404 });
    }
    if (isPrompts) {
      const rows = await db.prompt.findMany({
        where: { status: "published", featured: false },
        select: { id: true, updatedAt: true },
        orderBy: contentOrderBy,
        skip: offset,
        take: Math.min(CHUNK, cap - offset),
      });
      return xmlResponse(
        urlset(
          rows.map((p) => ({
            loc: `${base}/p/${p.id}`,
            lastmod: p.updatedAt,
            priority: 0.8,
            changefreq: "weekly",
          }))
        )
      );
    }
    const rows = await db.skill.findMany({
      where: { status: "published", featured: false },
      select: { id: true, slug: true, updatedAt: true },
      orderBy: contentOrderBy,
      skip: offset,
      take: Math.min(CHUNK, cap - offset),
    });
    return xmlResponse(
      urlset(
        rows.map((s) => ({
          loc: base + skillHref(s.slug, s.id),
          lastmod: s.updatedAt,
          priority: 0.7,
          changefreq: "weekly",
        }))
      )
    );
  }

  return new Response("Not found", { status: 404 });
}
