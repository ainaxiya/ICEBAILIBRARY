"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// ─── v0.114 通用收藏按钮（提示词 / 技能 / 软件详情页共用）───
// 未登录点击跳登录页（带 next 回跳）；已登录切换收藏（POST 幂等 toggle）。
// v0.117 星星胶囊款：未收藏=白底描边星「收藏」；已收藏=蓝渐变金实心星「已收藏」；按下有按压效果。

type FavType = "prompt" | "skill" | "software";

const STAR_PATH =
  "M12 2.5l2.95 5.98 6.6.96-4.78 4.66 1.13 6.58L12 17.58l-5.9 3.1 1.13-6.58L2.45 9.44l6.6-.96L12 2.5z";

export default function FavoriteButton({
  type,
  targetId,
  size = "md",
  className = "",
}: {
  type: FavType;
  targetId: number;
  size?: "sm" | "md";
  className?: string;
}) {
  const router = useRouter();
  const [fav, setFav] = useState<boolean | null>(null);
  const [loggedIn, setLoggedIn] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/user/favorites?type=${type}&targetId=${targetId}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setFav(!!d.favorited);
        setLoggedIn(d.loggedIn !== false);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [type, targetId]);

  const toggle = async () => {
    if (!loggedIn) {
      router.push(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/user/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, targetId }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && typeof d.favorited === "boolean") setFav(d.favorited);
    } catch {
      // 网络错误静默，按钮保持原状态
    } finally {
      setBusy(false);
    }
  };

  const isFav = fav === true;
  // sm=面包屑栏目行（高 30px，与旁边 chip 同排）；md=通用（高 34px）
  const pad = size === "sm" ? "h-[30px] px-3.5 text-sm gap-1.5" : "h-[34px] px-4 text-sm gap-2";
  const icon = size === "sm" ? "h-[18px] w-[18px]" : "h-5 w-5";

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={fav === null || busy}
      title={loggedIn ? (isFav ? "取消收藏" : "收藏") : "登录后收藏"}
      className={`inline-flex items-center rounded-full border font-semibold transition-all duration-150 ease-out active:scale-90 active:brightness-95 disabled:opacity-60 ${
        isFav
          ? "border-blue-400/70 bg-gradient-to-b from-sky-400 via-blue-500 to-indigo-600 text-white shadow-[0_3px_8px_rgba(30,64,175,0.45),inset_0_1px_0_rgba(255,255,255,0.35)] hover:from-sky-300 hover:via-blue-400 hover:to-indigo-500"
          : "border-blue-200 bg-gradient-to-b from-white to-blue-50 text-indigo-950 shadow-[0_2px_5px_rgba(30,64,175,0.18)] hover:border-blue-300 hover:to-blue-100"
      } ${pad} ${className}`}
    >
      {isFav ? (
        // 已收藏：金色实心星 + 闪光
        <svg viewBox="0 0 24 24" fill="none" className={icon}>
          <defs>
            <linearGradient id="favGold" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fde68a" />
              <stop offset="45%" stopColor="#fbbf24" />
              <stop offset="100%" stopColor="#f59e0b" />
            </linearGradient>
          </defs>
          <path d={STAR_PATH} fill="url(#favGold)" stroke="#b45309" strokeWidth="1" strokeLinejoin="round" />
          <path d="M19.2 1.6l.62 1.58 1.58.62-1.58.62-.62 1.58-.62-1.58-1.58-.62 1.58-.62.62-1.58z" fill="#fff" />
        </svg>
      ) : (
        // 未收藏：白底描边星
        <svg viewBox="0 0 24 24" fill="#e0e7ff" stroke="#4338ca" strokeWidth="1.8" strokeLinejoin="round" className={icon}>
          <path d={STAR_PATH} />
        </svg>
      )}
      <span
        className="leading-none"
        style={
          isFav
            ? { color: "#ffd600", textShadow: "-1px -1px 0 #bd4e00, 1px -1px 0 #bd4e00, -1px 1px 0 #bd4e00, 1px 1px 0 #bd4e00" }
            : undefined
        }
      >
        {fav === null ? "…" : isFav ? "已收藏" : "收藏"}
      </span>
    </button>
  );
}
