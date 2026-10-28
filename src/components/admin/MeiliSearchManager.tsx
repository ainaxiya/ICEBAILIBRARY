"use client";

import { useEffect, useState } from "react";
import { ADMIN_BASE } from "@/lib/admin-path";

// ─── 搜索管理（原生版，替代 meiliadmin 第三方 SPA iframe）───
// 通过现有 /meiliadmin/proxy/ 服务端代理访问 Meilisearch（Master Key 不下发浏览器）
// 三个 Tab：索引总览 / 搜索测试 / 文档浏览；顶部保留「搜索数据全更新」工具条

const PROXY = `${ADMIN_BASE}/meiliadmin/proxy`;

// 各索引搜索测试/文档浏览时展示的字段（对齐 reindex-meili.mjs 的文档结构）
const INDEX_FIELDS: Record<string, { key: string; label: string }[]> = {
  prompts: [
    { key: "title", label: "标题" },
    { key: "type", label: "类型" },
    { key: "category", label: "分类" },
    { key: "language", label: "语言" },
    { key: "tags", label: "标签" },
    { key: "viewCount", label: "浏览" },
    { key: "likeCount", label: "点赞" },
  ],
  skills: [
    { key: "name", label: "名称" },
    { key: "summary", label: "简介" },
    { key: "categorySlug", label: "分类" },
    { key: "tags", label: "标签" },
    { key: "viewCount", label: "浏览" },
    { key: "copyCount", label: "复制" },
  ],
  software: [
    { key: "name", label: "名称" },
    { key: "tagline", label: "简介" },
    { key: "platform", label: "平台" },
    { key: "tags", label: "标签" },
    { key: "viewCount", label: "浏览" },
    { key: "downloadCount", label: "下载" },
  ],
};

const INDEX_NAMES: Record<string, string> = {
  prompts: "提示词",
  skills: "AI技能",
  software: "AI软件",
};

async function fetchJSON(url: string, init?: RequestInit, timeoutMs = 15000): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, cache: "no-store", signal: ctl.signal });
    return await r.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-900/80 ${className}`}>{children}</div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span className="min-w-0 truncate text-zinc-200">{value}</span>
    </div>
  );
}

// ── Tab 1：索引总览 ──
function IndexOverview() {
  const [indexes, setIndexes] = useState<any[]>([]);
  const [stats, setStats] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        // Meilisearch v1.x：GET /indexes 返回分页对象 { results:[...] }；兼容旧版裸数组
        const raw = await fetchJSON(`${PROXY}/indexes`);
        const list = Array.isArray(raw) ? raw : raw?.results || [];
        setIndexes(list);
        const st: Record<string, any> = {};
        await Promise.all(
          list.map(async (ix: any) => {
            const s = await fetchJSON(`${PROXY}/indexes/${ix.uid}/stats`);
            st[ix.uid] = s;
          })
        );
        setStats(st);
      } catch (e) {
        setErr((e as Error).message || "加载失败");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <p className="py-10 text-center text-sm text-zinc-500">加载索引中…</p>;
  if (err) return <p className="py-10 text-center text-sm text-rose-400">加载失败：{err}（请确认 Meilisearch 服务与代理正常）</p>;
  if (indexes.length === 0) return <p className="py-10 text-center text-sm text-zinc-500">暂无索引，请先执行「搜索数据全更新」</p>;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {indexes.map((ix) => {
        const s = stats[ix.uid] || {};
        return (
          <Card key={ix.uid} className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-indigo-500/15 px-2 py-0.5 text-xs font-semibold text-indigo-300">{INDEX_NAMES[ix.uid] || ix.uid}</span>
                <code className="text-xs text-zinc-500">{ix.uid}</code>
              </div>
              {s.isIndexing && (
                <span className="flex items-center gap-1 text-xs text-amber-400">
                  <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-amber-400 border-t-transparent" />
                  索引中
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-zinc-800/50 p-2.5">
                <div className="text-[11px] text-zinc-500">文档数</div>
                <div className="text-lg font-semibold text-zinc-100">{(s.numberOfDocuments ?? 0).toLocaleString()}</div>
              </div>
              <div className="rounded-lg bg-zinc-800/50 p-2.5">
                <div className="text-[11px] text-zinc-500">存储</div>
                <div className="text-lg font-semibold text-zinc-100">
                  {s.databaseSize ? `${(s.databaseSize / 1024 / 1024).toFixed(1)} MB` : "-"}
                </div>
              </div>
            </div>
            <div className="mt-3 space-y-1.5 text-[11px] text-zinc-500">
              <div>可搜索字段：{(s.fieldDistribution ? Object.keys(s.fieldDistribution).length : 0)} 个</div>
              {s.lastUpdate && (
                <div className="truncate">更新：{new Date(s.lastUpdate).toLocaleString("zh-CN")}</div>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ── Tab 2：搜索测试 ──
function SearchTest() {
  const [uid, setUid] = useState("prompts");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<any[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState("");

  const fields = INDEX_FIELDS[uid] || INDEX_FIELDS.prompts;

  const run = async (keyword = q) => {
    const kw = keyword.trim();
    if (!kw) return;
    setSearching(true);
    setErr("");
    try {
      const d = await fetchJSON(`${PROXY}/indexes/${uid}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: kw, limit: 20 }),
      });
      if (!d) throw new Error("搜索无响应");
      setHits(d.hits || []);
      setTotal(d.estimatedTotalHits ?? null);
    } catch (e) {
      setErr((e as Error).message || "搜索失败");
      setHits([]);
      setTotal(null);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={uid}
          onChange={(e) => { setUid(e.target.value); setHits([]); setTotal(null); }}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500"
        >
          {Object.entries(INDEX_NAMES).map(([k, v]) => (
            <option key={k} value={k}>{v}（{k}）</option>
          ))}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="输入关键词测试搜索…"
          className="min-w-[220px] flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-indigo-500"
        />
        <button
          onClick={() => run()}
          disabled={searching || !q.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-b from-indigo-500 to-indigo-700 px-4 py-2 text-sm font-semibold text-white shadow-[0_8px_20px_-8px_rgba(99,102,241,0.6)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {searching && <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
          搜索
        </button>
      </div>

      {err && <p className="text-sm text-rose-400">{err}</p>}

      {total !== null && (
        <p className="text-xs text-zinc-500">共命中约 {total.toLocaleString()} 条（展示前 {hits.length} 条）</p>
      )}

      {hits.length > 0 && (
        <Card className="overflow-hidden">
          <div>
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-zinc-900 text-xs text-zinc-400">
                <tr>
                  <th className="px-3 py-2">#</th>
                  {fields.map((f) => (
                    <th key={f.key} className="px-3 py-2">{f.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {hits.map((h, i) => (
                  <tr key={h.id ?? i} className="hover:bg-zinc-800/40">
                    <td className="px-3 py-2 text-xs text-zinc-600">{i + 1}</td>
                    {fields.map((f) => {
                      const v = h[f.key];
                      const shown = Array.isArray(v) ? v.join(", ") : v == null ? "-" : String(v);
                      return (
                        <td key={f.key} className="max-w-[220px] truncate px-3 py-2 text-zinc-200" title={shown}>
                          {shown}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {hits.length === 0 && !searching && total === null && !err && (
        <p className="py-6 text-center text-sm text-zinc-500">输入关键词后点击「搜索」查看命中结果</p>
      )}
    </div>
  );
}

// ── Tab 3：文档浏览 ──
function DocumentBrowse() {
  const [uid, setUid] = useState("prompts");
  const [offset, setOffset] = useState(0);
  const [docs, setDocs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const pageSize = 20;

  const fields = INDEX_FIELDS[uid] || INDEX_FIELDS.prompts;

  const load = async (page: number) => {
    setLoading(true);
    setErr("");
    try {
      const off = page * pageSize;
      // Meilisearch v1.x：GET /documents 返回分页对象 { results:[...], total }；兼容旧版裸数组
      const raw = await fetchJSON(`${PROXY}/indexes/${uid}/documents?limit=${pageSize}&offset=${off}`);
      const list = Array.isArray(raw) ? raw : raw?.results || [];
      if (list.length === 0 && !Array.isArray(raw) && raw && typeof raw === "object" && !raw.results) {
        throw new Error("文档列表返回异常");
      }
      setDocs(list);
      setOffset(off);
    } catch (e) {
      setErr((e as Error).message || "加载失败");
      setDocs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(0); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [uid]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={uid}
          onChange={(e) => setUid(e.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-indigo-500"
        >
          {Object.entries(INDEX_NAMES).map(([k, v]) => (
            <option key={k} value={k}>{v}（{k}）</option>
          ))}
        </select>
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <button
            onClick={() => load(Math.max(0, offset / pageSize - 1))}
            disabled={loading || offset === 0}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            上一页
          </button>
          <span>第 {Math.floor(offset / pageSize) + 1} 页（每页 {pageSize} 条，从 #{offset + 1} 起）</span>
          <button
            onClick={() => load(offset / pageSize + 1)}
            disabled={loading || docs.length < pageSize}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            下一页
          </button>
        </div>
      </div>

      {err && <p className="text-sm text-rose-400">{err}</p>}
      {loading && <p className="text-sm text-zinc-500">加载文档…</p>}

      {docs.length > 0 && (
        <Card className="overflow-hidden">
          <div>
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-zinc-900 text-xs text-zinc-400">
                <tr>
                  <th className="px-3 py-2">id</th>
                  {fields.map((f) => (
                    <th key={f.key} className="px-3 py-2">{f.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {docs.map((d) => (
                  <tr key={d.id} className="hover:bg-zinc-800/40">
                    <td className="px-3 py-2 text-xs text-zinc-500">{d.id}</td>
                    {fields.map((f) => {
                      const v = d[f.key];
                      const shown = Array.isArray(v) ? v.join(", ") : v == null ? "-" : String(v);
                      return (
                        <td key={f.key} className="max-w-[220px] truncate px-3 py-2 text-zinc-200" title={shown}>
                          {shown}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {docs.length === 0 && !loading && !err && (
        <p className="py-6 text-center text-sm text-zinc-500">该索引暂无文档</p>
      )}
    </div>
  );
}

// ── 主面板 ──
export default function MeiliSearchManager() {
  const [tab, setTab] = useState<"overview" | "search" | "docs">("overview");

  const tabs: { id: typeof tab; label: string }[] = [
    { id: "overview", label: "索引总览" },
    { id: "search", label: "搜索测试" },
    { id: "docs", label: "文档浏览" },
  ];

  return (
    <div className="space-y-3">
      <div className="flex gap-1 rounded-xl border border-zinc-800 bg-zinc-900/80 p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition ${
              tab === t.id ? "bg-indigo-500/20 text-indigo-300" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <IndexOverview />}
      {tab === "search" && <SearchTest />}
      {tab === "docs" && <DocumentBrowse />}
    </div>
  );
}