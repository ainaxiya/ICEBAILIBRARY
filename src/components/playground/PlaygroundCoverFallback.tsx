"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// ─── 实验场封面降级（只在 playground 命名空间内使用）───
// 共享卡片（PromptCard → CardCover）自带回退，但那套回退在“无摘要”时会退化成灰图标，
// 且首屏水合前就 404 的图片拿不到 onError。这里在实验场自己的封装里补一层：
//   1) 捕获阶段监听 img 错误并阻止共享卡片的回退，统一换成站点气质的渐变占位；
//   2) 水合后补扫一次已失败（complete && naturalWidth === 0）的图片，覆盖 404 早于水合的情况；
//   3) 占位块与卡片封面同为 16:9（aspect-video），不产生布局跳动，也不出现默认破图标。
export default function PlaygroundCoverFallback({ children }: { children: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const scope = boxRef.current;
    if (!scope) return;
    const scan = () => {
      for (const img of Array.from(scope.querySelectorAll("img"))) {
        if (img.complete && img.naturalWidth === 0) {
          img.style.visibility = "hidden";
          setFailed(true);
          return;
        }
      }
    };
    scan();
    const timer = window.setTimeout(scan, 1500);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      ref={boxRef}
      className="relative"
      onErrorCapture={(e) => {
        const img = e.target as HTMLImageElement | null;
        if (img?.tagName !== "IMG") return;
        e.stopPropagation();
        img.style.visibility = "hidden";
        setFailed(true);
      }}
    >
      {children}
      {failed && (
        <div className="pointer-events-none absolute inset-x-0 top-0 aspect-video overflow-hidden rounded-t-xl bg-zinc-950">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_8%,rgba(16,185,129,0.22),transparent_58%),radial-gradient(circle_at_88%_92%,rgba(56,189,248,0.14),transparent_55%)]" />
          <div className="relative flex h-full w-full flex-col items-center justify-center gap-2 text-zinc-500">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-8 w-8 text-emerald-300/60"
            >
              <path d="M12 3.2 20 8v8l-8 4.8L4 16V8l8-4.8Z" />
              <path d="M12 3.2V12m0 0 8-4m-8 4-8-4m8 4v8.8" />
            </svg>
            <span className="text-xs tracking-wide text-zinc-500">封面暂缺</span>
          </div>
        </div>
      )}
    </div>
  );
}
