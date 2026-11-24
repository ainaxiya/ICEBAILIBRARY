"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

// ─── 「换一批」：换随机种子重新服务端渲染推荐区 ───
// 用 ?r=<时间戳> 触发同一路由的重新渲染（scroll: false 保持滚动位置），
// 服务端按种子做确定性洗牌，因此同一链接刷新结果稳定、换一批必然不同。

export default function RecommendRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(() => {
          router.push(`/playground?r=${Date.now()}`, { scroll: false });
        })
      }
      className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:border-emerald-500 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`h-4 w-4 ${pending ? "animate-spin" : ""}`}
      >
        <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
        <path d="M21 3v5h-5" />
      </svg>
      {pending ? "换一批中…" : "换一批"}
    </button>
  );
}
