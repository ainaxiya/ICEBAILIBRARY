"use client";

// 单页内容管理：页内布局（无弹层）——顶部页签选页面，主区直接编辑标题与富文本。
// RichEditor 以 slug 为 key 强制重挂载，切换页面时编辑器全新初始化，原数据必然回填。
import { useCallback, useEffect, useState } from "react";
import RichEditor from "@/components/RichEditor";

type PageRow = {
  slug: string;
  title: string;
  content: string;
  updatedAt: string;
};

const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-indigo-500";
const labelCls = "mb-1 block text-sm text-zinc-400";

const fmtTime = (s: string) => {
  try {
    return new Date(s).toLocaleString("zh-CN");
  } catch {
    return s;
  }
};

export default function SitePagesManager() {
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/settings/pages");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "加载失败");
      const list: PageRow[] = d.pages || [];
      setPages(list);
      return list;
    } catch (e) {
      setLoadError((e as Error).message);
      return [];
    }
  }, []);

  useEffect(() => {
    // 首次加载自动选中第一个页面，直接进入编辑态
    load().then((list) => {
      if (list.length > 0) {
        setSlug((cur) => cur || list[0].slug);
        setTitle((t) => t || list[0].title);
        setContent((c) => c || list[0].content || "");
      }
    });
  }, [load]);

  // 切换页面：回填该页原数据（title/content state 与 RichEditor key 同步重置）
  const select = (p: PageRow) => {
    setSlug(p.slug);
    setTitle(p.title);
    setContent(p.content || "");
    setSaved(false);
    setError("");
  };

  const save = async () => {
    if (!slug) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/admin/settings/pages", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, title, content }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "保存失败");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      const list = await load();
      // 保存后用服务端返回刷新 updatedAt 展示
      const cur = list.find((p) => p.slug === slug);
      if (cur) setTitle(cur.title);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return <p className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-6 text-center text-sm text-rose-300">加载失败：{loadError}</p>;
  }
  if (pages == null) {
    return <p className="py-10 text-center text-sm text-zinc-500">加载中…</p>;
  }

  const current = pages.find((p) => p.slug === slug) || null;

  return (
    <div>
      {/* 页签：固定单页列表（由接口按白名单返回） */}
      <div className="mb-4 flex flex-wrap gap-2">
        {pages.map((p) => (
          <button
            key={p.slug}
            type="button"
            onClick={() => select(p)}
            className={`rounded-lg px-4 py-2 text-sm transition ${
              p.slug === slug
                ? "bg-indigo-600 font-medium text-white"
                : "border border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700"
            }`}
          >
            {p.title}
          </button>
        ))}
      </div>

      {current ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <span className="text-xs text-zinc-500">
              /{current.slug} · 最后修改：{fmtTime(current.updatedAt)}
            </span>
            {saved && <span className="text-sm text-emerald-400">已保存 ✓</span>}
          </div>

          <div className="mb-4">
            <label className={labelCls}>页面标题（中文）</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
          </div>

          <div className="mb-4">
            <label className={labelCls}>页面内容（富文本，支持插入图片/视频）</label>
            <RichEditor
              key={current.slug}
              value={content}
              onChange={setContent}
              placeholder="输入单页内容…（留空则前台显示「内容整理中，敬请期待」）"
              minHeight={420}
            />
          </div>

          {error && <p className="mb-3 text-xs text-rose-400">{error}</p>}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={busy || !title.trim()}
              className="rounded-lg bg-indigo-600 px-6 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {busy ? "保存中…" : "保存"}
            </button>
            <a
              href={`/${current.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-zinc-500 transition hover:text-indigo-300"
            >
              前台预览 /{current.slug}
            </a>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-10 text-center text-sm text-zinc-500">
          请在上方选择要编辑的页面
        </div>
      )}
    </div>
  );
}
