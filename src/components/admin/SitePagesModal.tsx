"use client";

import { useEffect, useState } from "react";
import RichEditor from "@/components/RichEditor";

type PageRow = {
  slug: string;
  title: string;
  content: string;
  updatedAt: string;
};

const cardCls = "rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 mb-4";
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

// 单页内容修改：弹层列出 5 个固定页 → 点某页进编辑（标题 + 富文本）→ PUT 保存
// autoOpen：独立管理页（单页内容管理）挂载后直接打开列表弹层
export default function SitePagesModal({ autoOpen = false }: { autoOpen?: boolean }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pages, setPages] = useState<PageRow[]>([]);
  const [editing, setEditing] = useState<PageRow | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/settings/pages");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "加载失败");
      setPages(d.pages || []);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const openModal = () => {
    setOpen(true);
    setEditing(null);
    load();
  };

  useEffect(() => {
    if (autoOpen) openModal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editPage = (p: PageRow) => {
    setEditing(p);
    setTitle(p.title);
    setContent(p.content || "");
    setSaved(false);
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/settings/pages", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: editing.slug, title, content }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "保存失败");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className={cardCls}>
        <h3 className="mb-1 text-sm font-medium text-zinc-300">单页内容修改</h3>
        <p className="mb-4 text-xs text-zinc-500">
          编辑前台固定单页（使用帮助 / 关于我们 / 联系我们 / 服务条款 / 隐私政策）的标题与富文本内容，支持插入图片/视频，保存后前台立即生效。
        </p>
        <button
          type="button"
          onClick={openModal}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
        >
          单页内容修改
        </button>
      </div>

      {/* 页面列表弹层 */}
      {open && !editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-h-[86vh] w-full max-w-2xl overflow-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-base font-bold text-zinc-100">单页内容修改</h3>
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 transition hover:bg-zinc-700"
              >
                关闭
              </button>
            </div>
            {loading ? (
              <p className="py-10 text-center text-sm text-zinc-500">加载中…</p>
            ) : (
              <ul className="divide-y divide-zinc-800">
                {pages.map((p) => (
                  <li key={p.slug}>
                    <button
                      onClick={() => editPage(p)}
                      className="flex w-full items-center justify-between gap-3 px-1 py-3 text-left transition hover:bg-zinc-800/60"
                    >
                      <span className="text-sm text-zinc-200">{p.title}</span>
                      <span className="text-xs text-zinc-500">
                        /{p.slug} · 最后修改：{fmtTime(p.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* 编辑弹层 */}
      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 py-10"
          onClick={() => setEditing(null)}
        >
          <div
            className="w-full max-w-3xl rounded-2xl border border-zinc-700 bg-zinc-900 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-base font-bold text-zinc-100">
                编辑：{editing.title}
                <span className="ml-2 text-xs font-normal text-zinc-500">/{editing.slug}</span>
              </h3>
              <button
                onClick={() => setEditing(null)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 transition hover:bg-zinc-700"
              >
                返回列表
              </button>
            </div>

            <div className="mb-4">
              <label className={labelCls}>页面标题（中文）</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
            </div>

            <div className="mb-4">
              <label className={labelCls}>页面内容（富文本，支持插入图片/视频）</label>
              <RichEditor
                value={content}
                onChange={setContent}
                placeholder="输入单页内容…（留空则前台显示「内容整理中，敬请期待」）"
                minHeight={320}
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={save}
                disabled={busy || !title.trim()}
                className="rounded-lg bg-indigo-600 px-6 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {busy ? "保存中…" : "保存"}
              </button>
              {saved && <span className="text-sm text-emerald-400">已保存 ✓</span>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
