"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// ─── v0.117 收藏夹改版：提示词 + 技能混合卡片流（按收藏时间倒序）───
// AI 软件已下线不再展示；每张卡片带类型徽章 + 下级分类 + 「GO 实验场试用」按钮

type FavType = "prompt" | "skill";

type FavItem = {
  id: number;
  targetId: number;
  createdAt: string;
  title: string;
  href: string;
  summary: string | null;
  targetType: FavType;
  category: string | null;
};

const TYPE_STYLE: Record<
  FavType,
  { badge: string; icon: string; label: string; bar: string }
> = {
  prompt: {
    badge: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/25",
    icon: "📝",
    label: "提示词",
    bar: "from-emerald-400 via-emerald-500/60 to-transparent",
  },
  skill: {
    badge: "bg-violet-500/15 text-violet-300 ring-violet-400/25",
    icon: "🧩",
    label: "技能",
    bar: "from-violet-400 via-violet-500/60 to-transparent",
  },
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function FavoritesPanel() {
  const [items, setItems] = useState<FavItem[] | null>(null);
  const [err, setErr] = useState("");
  const [removingId, setRemovingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setItems(null);
    setErr("");
    try {
      const r = await fetch("/api/user/favorites?type=all");
      const d = await r.json();
      if (r.ok) setItems(d.items || []);
      else setErr(d.error || "加载失败");
    } catch {
      setErr("加载失败，请稍后重试");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (it: FavItem) => {
    setRemovingId(it.targetId);
    try {
      const r = await fetch("/api/user/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: it.targetType, targetId: it.targetId }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.favorited === false) {
        setItems((prev) => (prev || []).filter((x) => !(x.targetType === it.targetType && x.targetId === it.targetId)));
      } else if (!r.ok) {
        setErr(d.error || "操作失败");
      }
    } catch {
      setErr("网络错误，请稍后重试");
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div>
      {/* 总览 */}
      <div className="mb-4 flex flex-wrap items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div>
          <p className="text-xs text-zinc-500">我的收藏</p>
          <p className="mt-1 text-3xl font-bold text-emerald-400">{items ? items.length : "—"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1 text-xs text-emerald-300">
            📝 提示词 {items ? items.filter((x) => x.targetType === "prompt").length : 0}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/15 px-3 py-1 text-xs text-violet-300">
            🧩 技能 {items ? items.filter((x) => x.targetType === "skill").length : 0}
          </span>
        </div>
        <p className="ml-auto max-w-xs text-xs text-zinc-500">
          提示词与技能混合展示，按收藏时间倒序；点击「GO 实验场试用」一键在实验场中体验
        </p>
      </div>

      {err && <p className="mb-2 text-xs text-rose-400">{err}</p>}

      {items == null && !err ? (
        <div className="rounded-xl border border-zinc-800 p-6 text-center text-sm text-zinc-500">加载中…</div>
      ) : (items || []).length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-10 text-center">
          <p className="text-sm text-zinc-400">还没有收藏内容</p>
          <p className="mt-1.5 text-xs text-zinc-600">在提示词 / 技能详情页点击「收藏」按钮即可加入</p>
          <div className="mt-4 flex flex-wrap justify-center gap-3">
            <Link href="/categories" className="rounded-lg bg-emerald-500/15 px-4 py-2 text-xs font-medium text-emerald-300 transition hover:opacity-80">
              📚 去逛提示词库
            </Link>
            <Link href="/skills" className="rounded-lg bg-violet-500/15 px-4 py-2 text-xs font-medium text-violet-300 transition hover:opacity-80">
              🧩 去逛技能库
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {(items || []).map((it) => {
            const st = TYPE_STYLE[it.targetType];
            const busy = removingId === it.targetId;
            return (
              <div
                key={`${it.targetType}-${it.targetId}`}
                className="group relative flex flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 transition hover:-translate-y-0.5 hover:border-emerald-400/40 hover:shadow-[0_12px_40px_-12px_rgba(56,189,248,0.4)]"
              >
                <span aria-hidden className={`absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b ${st.bar}`} />
                {/* 类型徽章 + 下级分类 + 收藏时间 */}
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-medium ring-1 ${st.badge}`}>
                    {st.icon} {st.label}
                  </span>
                  {it.category && (
                    <span className="rounded-full bg-zinc-800/80 px-2 py-0.5 text-zinc-400">{it.category}</span>
                  )}
                  <span className="ml-auto text-zinc-600">{fmtDate(it.createdAt)} 收藏</span>
                </div>
                {/* 标题 + 摘要（点卡片进详情） */}
                <Link href={it.href} className="mt-2.5 min-w-0">
                  <h3 className="line-clamp-1 text-[15px] font-semibold text-zinc-100 transition group-hover:text-white">
                    {it.title}
                  </h3>
                  {it.summary && (
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-400">{it.summary}</p>
                  )}
                </Link>
                {/* 底部操作行 */}
                <div className="mt-3 flex items-center gap-2 border-t border-zinc-800/70 pt-3">
                  <Link
                    href="/playground"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-sky-500 to-indigo-500 px-3 py-1.5 text-xs font-semibold text-white shadow-md shadow-sky-900/30 transition hover:from-sky-400 hover:to-indigo-400 active:scale-95"
                    title="在实验场中一键试用"
                  >
                    GO 实验场试用
                  </Link>
                  <Link
                    href={it.href}
                    className="ml-auto rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
                  >
                    查看详情
                  </Link>
                  <button
                    type="button"
                    onClick={() => remove(it)}
                    disabled={busy}
                    className="rounded-lg border border-rose-800/60 px-2.5 py-1.5 text-xs text-rose-300 transition hover:border-rose-500 hover:bg-rose-500/10 disabled:opacity-50"
                    title="取消收藏"
                  >
                    {busy ? "…" : "移除"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
