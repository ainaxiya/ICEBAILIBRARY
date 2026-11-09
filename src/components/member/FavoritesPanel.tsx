"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// ─── v0.92 #9 收藏夹：提示词 / 技能 / 软件 三类收藏 ───

type FavType = "prompt" | "skill" | "software";

type FavItem = {
  id: number;
  targetId: number;
  createdAt: string;
  title: string;
  href: string;
  summary: string | null;
};

const TYPE_LABEL: Record<FavType, string> = {
  prompt: "提示词",
  skill: "技能",
  software: "软件",
};
const TYPE_ICON: Record<FavType, string> = {
  prompt: "📝",
  skill: "🧩",
  software: "💿",
};

export default function FavoritesPanel() {
  const [type, setType] = useState<FavType>("prompt");
  const [items, setItems] = useState<FavItem[] | null>(null);
  const [err, setErr] = useState("");
  const [removingId, setRemovingId] = useState<number | null>(null);

  const load = useCallback(async (t: FavType) => {
    setItems(null);
    setErr("");
    try {
      const r = await fetch(`/api/user/favorites?type=${t}`);
      const d = await r.json();
      if (r.ok) setItems(d.items || []);
      else setErr(d.error || "加载失败");
    } catch {
      setErr("加载失败，请稍后重试");
    }
  }, []);

  useEffect(() => {
    load(type);
  }, [type, load]);

  const remove = async (it: FavItem) => {
    setRemovingId(it.targetId);
    try {
      const r = await fetch("/api/user/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, targetId: it.targetId }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.favorited === false) {
        setItems((prev) => (prev || []).filter((x) => x.targetId !== it.targetId));
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
      {/* 三类切换 */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {(Object.keys(TYPE_LABEL) as FavType[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            className={`rounded-lg px-3.5 py-1.5 text-sm ${
              type === t ? "bg-emerald-500/15 text-emerald-300" : "text-zinc-400 hover:bg-zinc-800"
            }`}
          >
            {TYPE_ICON[t]} {TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      {err && <p className="mb-2 text-xs text-rose-400">{err}</p>}

      <div className="overflow-hidden rounded-xl border border-zinc-800">
        {items == null ? (
          <div className="p-6 text-center text-sm text-zinc-500">加载中…</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">
            还没有收藏的{TYPE_LABEL[type]}
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800/70">
            {items.map((it) => (
              <li key={`${type}-${it.targetId}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="text-xl">{TYPE_ICON[type]}</span>
                <div className="min-w-0 flex-1">
                  <Link href={it.href} className="text-sm text-zinc-200 hover:text-emerald-300">
                    {it.title}
                  </Link>
                  {it.summary && <p className="mt-0.5 line-clamp-1 text-xs text-zinc-500">{it.summary}</p>}
                  <p className="mt-0.5 text-[11px] text-zinc-600">收藏于 {String(it.createdAt).slice(0, 10)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => remove(it)}
                  disabled={removingId === it.targetId}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-rose-500 hover:text-rose-300 disabled:opacity-40"
                >
                  {removingId === it.targetId ? "处理中…" : "取消收藏"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
