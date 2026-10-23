"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ADMIN_BASE } from "@/lib/admin-path";

type Cat = { id: number; name: string; slug: string };
type SoftRow = {
  id: number; slug: string; name: string; version: string | null; tagline: string | null;
  icon: string | null; status: string;
  viewCount: number; downloadCount: number; commentCount: number; downloadEntries: number;
  publishedAt: string | null; createdAt: string;
  category: Cat;
};

export default function SoftwareList({ cats }: { cats: Cat[] }) {
  const [rows, setRows] = useState<SoftRow[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const pageSize = 30;

  const flash = (kind: "ok" | "err", text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 3000);
  };

  const load = useCallback(async (p = page, kw = q, st = status, cid = categoryId) => {
    setLoading(true);
    try {
      const u = new URL("/api/admin/software", location.origin);
      u.searchParams.set("page", String(p));
      if (kw) u.searchParams.set("q", kw);
      if (st) u.searchParams.set("status", st);
      if (cid) u.searchParams.set("categoryId", cid);
      const r = await fetch(u);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "加载失败");
      setRows(d.list); setTotal(d.total); setCounts(d.counts || {});
    } catch (e) {
      flash("err", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, q, status, categoryId]);

  useEffect(() => { load(1); setPage(1); }, [status, categoryId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(page); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = () => { setPage(1); load(1); };

  const remove = async (s: SoftRow) => {
    if (!confirm(`确定删除软件「${s.name}」吗？\n评论将保留为无主评论，可在评论管理中手动清理。`)) return;
    try {
      const r = await fetch(`/api/admin/software/${s.id}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "删除失败");
      flash("ok", "已删除");
      load();
    } catch (e) {
      flash("err", (e as Error).message);
    }
  };

  const setSt = async (s: SoftRow, st: string) => {
    try {
      const r = await fetch(`/api/admin/software/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: st }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "操作失败");
      flash("ok", st === "published" ? "已发布" : st === "rejected" ? "已拒绝" : "已转待审");
      load();
    } catch (e) {
      flash("err", (e as Error).message);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const statusBadge = (st: string) =>
    st === "published"
      ? <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-400">已发布</span>
      : st === "pending"
        ? <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-400">待审</span>
        : <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-xs text-rose-400">已拒绝</span>;

  return (
    <div>
      {msg && (
        <div className={`mb-3 rounded-lg px-3 py-2 text-sm ${msg.kind === "ok" ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}>
          {msg.text}
        </div>
      )}

      {/* 筛选栏 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="搜索名称/简介…"
          className="w-56 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
        />
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm">
          <option value="">全部分类</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm">
          <option value="">全部状态</option>
          <option value="published">已发布{counts.published ? ` (${counts.published})` : ""}</option>
          <option value="pending">待审{counts.pending ? ` (${counts.pending})` : ""}</option>
          <option value="rejected">已拒绝{counts.rejected ? ` (${counts.rejected})` : ""}</option>
        </select>
        <button type="button" onClick={search} className="rounded-lg bg-zinc-700 px-3 py-1.5 text-sm text-white hover:bg-zinc-600">查询</button>
        <span className="ml-auto text-xs text-zinc-500">共 {total} 条</span>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <th className="px-4 py-3">软件</th>
              <th className="px-4 py-3 w-28">分类</th>
              <th className="px-4 py-3 w-20">状态</th>
              <th className="px-4 py-3 w-40">统计</th>
              <th className="px-4 py-3 w-44 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {!loading && rows.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-zinc-600">暂无软件，点击右上角「新增软件」</td></tr>
            )}
            {loading && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-zinc-600">加载中…</td></tr>
            )}
            {rows.map((s) => (
              <tr key={s.id} className="hover:bg-zinc-800/30">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    {s.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.icon} alt="" className="h-9 w-9 shrink-0 rounded-lg border border-zinc-800 object-cover" />
                    ) : (
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-zinc-800 bg-zinc-800 text-sm text-zinc-500">
                        {s.name.slice(0, 1)}
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="font-medium text-zinc-100">
                        {s.name}
                        {s.version && <span className="ml-1.5 text-xs text-zinc-500">v{s.version}</span>}
                      </div>
                      <div className="mt-0.5 max-w-md truncate text-xs text-zinc-500" title={s.tagline || ""}>{s.tagline}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-zinc-400">{s.category.name}</td>
                <td className="px-4 py-3">{statusBadge(s.status)}</td>
                <td className="px-4 py-3 text-xs text-zinc-500">
                  看{s.viewCount} · 下{s.downloadCount} · 评{s.commentCount} · {s.downloadEntries}个下载
                </td>
                <td className="px-4 py-3 text-right">
                  <a href={`/software/${s.slug}`} target="_blank" rel="noreferrer" className="mr-2 text-zinc-400 hover:underline">预览</a>
                  <Link href={`${ADMIN_BASE}/software/${s.id}/edit`} className="mr-2 text-sky-400 hover:underline">编辑</Link>
                  {s.status !== "published" && (
                    <button type="button" onClick={() => setSt(s, "published")} className="mr-2 text-emerald-400 hover:underline">发布</button>
                  )}
                  <button type="button" onClick={() => remove(s)} className="text-rose-400 hover:underline">删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center gap-2 text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border border-zinc-700 px-2.5 py-1 disabled:opacity-40">上一页</button>
          <span className="text-zinc-500">{page} / {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="rounded border border-zinc-700 px-2.5 py-1 disabled:opacity-40">下一页</button>
        </div>
      )}
    </div>
  );
}
