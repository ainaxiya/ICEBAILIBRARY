"use client";

import { useEffect, useState } from "react";

// 提示词详情页「本页结构」分段导航
// 桌面（≥1280px）：左侧吸顶目录，两位数编号 + 当前分段高亮
// 手机/中小屏：目录隐藏为右下角小图标，点开弹层选段

export type TocSegment = { index: number; label: string };

const pad2 = (n: number) => String(n).padStart(2, "0");

export default function PromptToc({ segments }: { segments: TocSegment[] }) {
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  // 滚动监听：高亮当前阅读分段
  useEffect(() => {
    const els = segments
      .map((s) => document.getElementById(`seg-${s.index}`))
      .filter((el): el is HTMLElement => !!el);
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const idx = Number((e.target as HTMLElement).dataset.segIndex);
            if (!Number.isNaN(idx)) setActive(idx);
          }
        }
      },
      { rootMargin: "-90px 0px -55% 0px", threshold: 0 }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [segments]);

  const jump = (e: React.MouseEvent, i: number) => {
    e.preventDefault();
    document.getElementById(`seg-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setOpen(false);
    setActive(i);
  };

  const items = segments.map((seg) => (
    <a
      key={seg.index}
      href={`#seg-${seg.index}`}
      onClick={(e) => jump(e, seg.index)}
      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition ${
        active === seg.index
          ? "bg-emerald-500/15 text-emerald-300"
          : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
      }`}
    >
      <span className={`font-mono text-xs ${active === seg.index ? "text-emerald-400" : "text-zinc-600"}`}>
        {pad2(seg.index + 1)}
      </span>
      <span className="min-w-0 flex-1 truncate">{seg.label}</span>
      {active === seg.index && (
        <span className="shrink-0 rounded bg-emerald-500/20 px-1 py-0.5 text-xs text-emerald-300">当前阅读</span>
      )}
    </a>
  ));

  return (
    <>
      {/* 桌面：左侧吸顶目录 */}
      <aside className="hidden w-[190px] shrink-0 xl:block">
        <div className="sticky top-20 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
          <h4 className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-zinc-400">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
            </svg>
            本页结构
            <span className="ml-auto font-mono text-xs text-zinc-600">{pad2(segments.length)} 段</span>
          </h4>
          <nav className="space-y-0.5">{items}</nav>
        </div>
      </aside>

      {/* 手机/中小屏：右下角小图标 */}
      <button
        onClick={() => setOpen(true)}
        aria-label="本页结构"
        className="fixed bottom-24 right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-emerald-500/40 bg-zinc-900/95 text-emerald-300 shadow-[0_10px_28px_-8px_rgba(0,0,0,0.7)] transition hover:bg-zinc-800 xl:hidden"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
      </button>

      {/* 弹层选段 */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center xl:hidden">
          <div
            className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-900 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-bold text-zinc-100">
                本页结构
                <span className="font-mono text-xs font-normal text-zinc-500">共 {pad2(segments.length)} 段</span>
              </h3>
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 transition hover:bg-zinc-700"
              >
                关闭
              </button>
            </div>
            <div className="max-h-[60vh] space-y-1 overflow-auto">{items}</div>
          </div>
        </div>
      )}
    </>
  );
}
