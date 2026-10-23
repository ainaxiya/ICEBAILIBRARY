"use client";

import { useState } from "react";

// 技能详情页操作按钮：Copy SKILL.md（复制成功后才计一次复制数，每技能每会话只计一次）
export default function SkillActions({
  skillId,
  skillMd,
  hasFiles,
  locale = "zh",
}: {
  skillId: number;
  skillMd: string;
  hasFiles: boolean;
  locale?: string;
}) {
  const [ok, setOk] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(skillMd);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = skillMd;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setOk(true);
    setTimeout(() => setOk(false), 1500);
    // 会话级防抖：同一技能重复复制只计一次
    const key = `skill-copied-${skillId}`;
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, "1");
      fetch(`/api/skills/${skillId}/copy`, { method: "POST" }).catch(() => {});
    }
  };

  return (
    <div className="flex flex-wrap gap-2.5">
      <button
        type="button"
        onClick={copy}
        className={`inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold shadow-lg transition active:scale-95 ${
          ok
            ? "bg-emerald-400 text-zinc-950 shadow-emerald-500/30"
            : "bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-emerald-600/25 hover:from-emerald-400 hover:to-teal-400"
        }`}
      >
        {ok ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-4 w-4"><path d="M20 6L9 17l-5-5"/></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        )}
        {ok ? (locale === "zh" ? "已复制" : "Copied") : "Copy SKILL.md"}
      </button>
      <a
        href={`/api/skills/${skillId}/download`}
        className="inline-flex items-center gap-2 rounded-xl border border-violet-600/60 bg-violet-500/10 px-5 py-2.5 text-sm font-semibold text-violet-300 shadow-lg shadow-violet-900/20 transition hover:border-violet-500 hover:bg-violet-500/20 hover:text-violet-200 active:scale-95"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        {hasFiles ? "Download (.zip)" : "Download (.md)"}
      </a>
    </div>
  );
}
