// 全量重建 Meili 索引（v0.6：prompts / skills / software 三索引）
// 用法：node scripts/reindex-meili.mjs [prompts|skills|software]（缺省全部）
import { PrismaClient } from "@prisma/client";
import { MeiliSearch } from "meilisearch";
import "dotenv/config";

const db = new PrismaClient();
const meili = new MeiliSearch({
  host: process.env.MEILI_HOST || "http://127.0.0.1:7700",
  apiKey: process.env.MEILI_MASTER_KEY || "",
});

function stripHtml(s) {
  if (!s) return "";
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const INDEXES = {
  prompts: {
    index: meili.index("prompts"),
    count: () => db.prompt.count({ where: { status: "published" } }),
    fetch: (skip, take) =>
      db.prompt.findMany({
        where: { status: "published" },
        orderBy: { id: "asc" }, skip, take,
        include: { user: { select: { username: true } } },
      }),
    toDoc: (p) => ({
      id: p.id,
      title: p.title,
      content: stripHtml(p.content).slice(0, 15000),
      description: (p.description || "").slice(0, 2000),
      type: p.type,
      category: p.category,
      language: p.language,
      tags: p.tags,
      sourceAuthor: p.sourceAuthor || p.user.username,
      promptCode: p.promptCode,
      coverUrl: p.coverUrl,
      featured: p.featured,
      likeCount: p.likeCount,
      viewCount: p.viewCount,
      createdAtTs: Math.floor(p.createdAt.getTime() / 1000),
    }),
    settings: async (idx) => {
      await idx.updateFilterableAttributes(["type", "tags", "category", "language"]);
      await idx.updateSortableAttributes(["likeCount", "viewCount", "createdAtTs"]);
      // 标题/描述优先于正文参与排名，正文只做兜底匹配（热度加权在搜索页层补偿）
      await idx.updateSearchableAttributes(["title", "description", "tags", "content", "promptCode", "sourceAuthor"]);
    },
  },
  skills: {
    index: meili.index("skills"),
    count: () => db.skill.count({ where: { status: "published" } }),
    fetch: (skip, take) =>
      db.skill.findMany({
        where: { status: "published" },
        orderBy: { id: "asc" }, skip, take,
        include: { category: { select: { slug: true } } },
      }),
    toDoc: (s) => ({
      id: s.id,
      name: s.name,
      summary: (s.summary || "").slice(0, 2000),
      skillMd: (s.skillMd || "").slice(0, 15000),
      tags: s.tags,
      author: s.author || null,
      categoryId: s.categoryId,
      categorySlug: s.category?.slug || null,
      language: s.language,
      viewCount: s.viewCount,
      copyCount: s.copyCount,
      createdAtTs: Math.floor(s.createdAt.getTime() / 1000),
    }),
    settings: async (idx) => {
      await idx.updateFilterableAttributes(["tags", "categoryId", "categorySlug", "language"]);
      await idx.updateSortableAttributes(["viewCount", "copyCount", "createdAtTs"]);
      await idx.updateSearchableAttributes(["name", "summary", "tags", "skillMd"]);
    },
  },
  software: {
    index: meili.index("software"),
    count: () => db.software.count({ where: { status: "published" } }),
    fetch: (skip, take) =>
      db.software.findMany({
        where: { status: "published" },
        orderBy: { id: "asc" }, skip, take,
        include: { category: { select: { slug: true } } },
      }),
    toDoc: (s) => ({
      id: s.id,
      name: s.name,
      tagline: (s.tagline || "").slice(0, 500),
      description: stripHtml(s.description || "").slice(0, 10000),
      tags: s.tags,
      categoryId: s.categoryId,
      categorySlug: s.category?.slug || null,
      platform: s.platform || null,
      icon: s.icon || null,
      version: s.version || null,
      viewCount: s.viewCount,
      downloadCount: s.downloadCount,
      createdAtTs: Math.floor(s.createdAt.getTime() / 1000),
    }),
    settings: async (idx) => {
      await idx.updateFilterableAttributes(["tags", "categoryId", "categorySlug", "platform"]);
      await idx.updateSortableAttributes(["viewCount", "downloadCount", "createdAtTs"]);
      await idx.updateSearchableAttributes(["name", "tagline", "tags", "description"]);
    },
  },
};

async function reindex(key, cfg) {
  const total = await cfg.count();
  console.log(`[${key}] published:`, total);
  await cfg.settings(cfg.index);
  let processed = 0;
  const take = 500;
  for (let skip = 0; skip < total; skip += take) {
    const rows = await cfg.fetch(skip, take);
    const docs = rows.map(cfg.toDoc);
    if (docs.length) await cfg.index.addDocuments(docs, { primaryKey: "id" });
    processed += docs.length;
    process.stdout.write(`\r[${key}] indexed ${processed}/${total}`);
  }
  console.log(`\n[${key}] done`);
}

async function main() {
  const only = process.argv[2];
  const keys = only ? [only] : Object.keys(INDEXES);
  for (const k of keys) {
    if (!INDEXES[k]) { console.error("unknown index:", k); process.exit(1); }
    await reindex(k, INDEXES[k]);
  }
  await new Promise((r) => setTimeout(r, 2000));
  console.log("all done");
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
