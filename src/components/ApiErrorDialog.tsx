"use client";

import Link from "next/link";
import type { ErrorGuide } from "@/lib/error-guide";

// b7：失败原因弹窗 —— 错误码 + 人话 + 建议动作（只做展示，不改任何请求逻辑）
export default function ApiErrorDialog({
  guide,
  onClose,
}: {
  guide: ErrorGuide | null;
  onClose: () => void;
}) {
  if (!guide) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={guide.title}
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="关闭"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/60"
      />
      <div className="relative w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-100">{guide.title}</h3>
            <p className="mt-1 text-xs text-slate-500">
              错误码 <code className="text-rose-300">{guide.code}</code>
              {guide.matched ? "" : "（未收录，展示服务端原始提示）"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-zinc-800 hover:text-slate-200"
          >
            ✕
          </button>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-slate-300">{guide.detail}</p>

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {guide.actions.map((a) =>
            a.href ? (
              <Link
                key={a.label}
                href={a.href}
                className="rounded-lg bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/25"
              >
                {a.label}
              </Link>
            ) : (
              <button
                key={a.label}
                type="button"
                onClick={onClose}
                className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-zinc-700"
              >
                {a.label}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
