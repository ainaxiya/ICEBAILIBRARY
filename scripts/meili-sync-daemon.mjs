// Meilisearch 秒级增量同步守护进程（PM2 常驻）
//
// 作用：轮询 SiteSetting(site.meiliSyncSeconds) 配置的间隔，把数据库中
// updatedAt 大于水位线的记录增量推送到 Meilisearch；下线/删除的文档从索引移除。
// v0.6 起支持多索引：prompts / skills / software，各自独立水位线。
// 应用自身的增删改接口已实时同步，本进程是兜底（采集入库、直接改库、计数漂移等）。
//
// 启动：
//   pm2 start scripts/meili-sync-daemon.mjs --name CompletePrompt-MeiliSync
//   pm2 save
// 日志：pm2 logs CompletePrompt-MeiliSync
// 停止：pm2 stop CompletePrompt-MeiliSync
//
// 间隔在后台「网站设置 → 搜索索引」修改，下一轮询自动生效；填 0 = 暂停自动同步。

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { MeiliSearch } from "meilisearch";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "..", ".meili-sync-state.json");

const db = new PrismaClient();
const meili = new MeiliSearch({
  host: process.env.MEILI_HOST || "http://127.0.0.1:7700",
  apiKey: process.env.MEILI_MASTER_KEY || "",
});

const BATCH = 200;
const DEFAULT_INTERVAL = 30;
const IDLE_TICK = 10_000;
const RECONCILE_EVERY = 10 * 60_000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

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

// ─── 多索引配置 ───
const INDEXES = [
  {
    key: "prompts",
    index: meili.index("prompts"),
    fetch: (watermark) =>
      db.prompt.findMany({
        where: { updatedAt: { gt: watermark } },
        orderBy: { updatedAt: "asc" },
        take: BATCH,
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
      sourceAuthor: p.sourceAuthor || p.user?.username || null,
      promptCode: p.promptCode,
      coverUrl: p.coverUrl,
      featured: p.featured,
      likeCount: p.likeCount,
      viewCount: p.viewCount,
      createdAtTs: Math.floor(p.createdAt.getTime() / 1000),
    }),
    alive: (p) => p.status === "published",
    aliveBatch: async (ids) => {
      const rows = await db.prompt.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
      return new Set(rows.filter((r) => r.status === "published").map((r) => r.id));
    },
    settings: async (idx) => {
      await Promise.all([
        idx.updateFilterableAttributes(["type", "tags", "category", "language"]),
        idx.updateSortableAttributes(["likeCount", "viewCount", "createdAtTs"]),
        // 与 reindex-meili.mjs 保持一致：标题/描述优先参与排名，正文兜底
        idx.updateSearchableAttributes(["title", "description", "tags", "content", "promptCode", "sourceAuthor"]),
      ]);
    },
  },
  {
    key: "skills",
    index: meili.index("skills"),
    fetch: (watermark) =>
      db.skill.findMany({
        where: { updatedAt: { gt: watermark } },
        orderBy: { updatedAt: "asc" },
        take: BATCH,
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
    alive: (s) => s.status === "published",
    aliveBatch: async (ids) => {
      const rows = await db.skill.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
      return new Set(rows.filter((r) => r.status === "published").map((r) => r.id));
    },
    settings: async (idx) => {
      await Promise.all([
        idx.updateFilterableAttributes(["tags", "categoryId", "categorySlug", "language"]),
        idx.updateSortableAttributes(["viewCount", "copyCount", "createdAtTs"]),
        idx.updateSearchableAttributes(["name", "summary", "tags", "skillMd"]),
      ]);
    },
  },
  {
    key: "software",
    index: meili.index("software"),
    fetch: (watermark) =>
      db.software.findMany({
        where: { updatedAt: { gt: watermark } },
        orderBy: { updatedAt: "asc" },
        take: BATCH,
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
    alive: (s) => s.status === "published",
    aliveBatch: async (ids) => {
      const rows = await db.software.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
      return new Set(rows.filter((r) => r.status === "published").map((r) => r.id));
    },
    settings: async (idx) => {
      await Promise.all([
        idx.updateFilterableAttributes(["tags", "categoryId", "categorySlug", "platform"]),
        idx.updateSortableAttributes(["viewCount", "downloadCount", "createdAtTs"]),
        idx.updateSearchableAttributes(["name", "tagline", "tags", "description"]),
      ]);
    },
  },
];

// ─── 水位线状态（每索引独立；兼容 v0.5 单水位格式） ───
function loadWatermarks() {
  const fallback = new Date(Date.now() - 120_000);
  try {
    if (existsSync(STATE_FILE)) {
      const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (s.watermarks) {
        return Object.fromEntries(
          INDEXES.map((ix) => [ix.key, s.watermarks[ix.key] ? new Date(s.watermarks[ix.key]) : fallback])
        );
      }
      if (s.watermark) {
        // v0.5 格式：prompts 沿用旧水位，其余从近 2 分钟开始
        return Object.fromEntries(
          INDEXES.map((ix) => [ix.key, ix.key === "prompts" ? new Date(s.watermark) : fallback])
        );
      }
    }
  } catch {}
  return Object.fromEntries(INDEXES.map((ix) => [ix.key, fallback]));
}
const watermarks = loadWatermarks();
function saveWatermarks() {
  try {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ watermarks: Object.fromEntries(Object.entries(watermarks).map(([k, v]) => [k, v.toISOString()])) })
    );
  } catch (e) {
    console.error("save watermark failed:", e.message);
  }
}

// ─── 配置：直接查 SiteSetting，绕过 Next 层缓存 ───
async function getIntervalSeconds() {
  try {
    const row = await db.siteSetting.findUnique({ where: { key: "site" } });
    if (row) {
      const v = JSON.parse(row.value);
      const n = Number(v.meiliSyncSeconds);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch {}
  return DEFAULT_INTERVAL;
}

// ─── 单索引增量同步一轮 ───
async function tickIndex(ix) {
  let touched = 0;
  for (;;) {
    const rows = await ix.fetch(watermarks[ix.key]);
    if (rows.length === 0) break;

    const upserts = rows.filter(ix.alive).map(ix.toDoc);
    const deletes = rows.filter((r) => !ix.alive(r)).map((r) => r.id);

    if (upserts.length) await ix.index.addDocuments(upserts, { primaryKey: "id" });
    if (deletes.length) await ix.index.deleteDocuments(deletes);

    watermarks[ix.key] = rows[rows.length - 1].updatedAt;
    saveWatermarks();
    touched += rows.length;
    if (rows.length < BATCH) break;
  }
  return touched;
}

// ─── 硬删除对账：索引里存在、DB 已不存在（或已下线）的文档清掉 ───
// 存活检查改为批量查询（1000/批），替代逐条 findUnique，消除 N+1
async function reconcileIndex(ix) {
  const indexedIds = new Set();
  let offset = 0;
  for (;;) {
    const docs = await ix.index.getDocuments({ limit: 1000, offset, fields: ["id"] });
    if (!docs.results.length) break;
    for (const d of docs.results) indexedIds.add(Number(d.id));
    offset += docs.results.length;
    if (docs.results.length < 1000) break;
  }
  if (indexedIds.size === 0) return 0;

  const ids = [...indexedIds];
  const alive = new Set();
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    for (const id of await ix.aliveBatch(chunk)) alive.add(id);
  }

  const stale = ids.filter((id) => !alive.has(id));
  for (let i = 0; i < stale.length; i += 500) {
    await ix.index.deleteDocuments(stale.slice(i, i + 500));
  }
  return stale.length;
}

async function ensureSettings() {
  for (const ix of INDEXES) {
    try {
      await ix.settings(ix.index);
    } catch (e) {
      console.error(`ensure index settings failed [${ix.key}]:`, e.message);
    }
  }
}

async function main() {
  log("MeiliSync daemon started, host =", process.env.MEILI_HOST || "http://127.0.0.1:7700", "| indexes:", INDEXES.map((i) => i.key).join(","));
  await ensureSettings();
  let lastReconcile = 0;

  for (;;) {
    const interval = await getIntervalSeconds();
    try {
      if (interval > 0) {
        let totalTouched = 0;
        for (const ix of INDEXES) totalTouched += await tickIndex(ix);
        if (totalTouched) log(`incremental sync: ${totalTouched} changed`);

        if (Date.now() - lastReconcile > RECONCILE_EVERY) {
          for (const ix of INDEXES) {
            const removed = await reconcileIndex(ix);
            if (removed) log(`reconcile[${ix.key}]: removed ${removed} stale docs`);
          }
          lastReconcile = Date.now();
        }
        await new Promise((r) => setTimeout(r, interval * 1000));
      } else {
        await new Promise((r) => setTimeout(r, IDLE_TICK));
      }
    } catch (e) {
      console.error("sync tick failed:", e.message);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    saveWatermarks();
    await db.$disconnect().catch(() => {});
    process.exit(0);
  });
}
