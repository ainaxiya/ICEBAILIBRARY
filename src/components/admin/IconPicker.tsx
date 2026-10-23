"use client";

import { useState } from "react";

// 常用分类图标候选（emoji，免上传）
export const ICON_CHOICES = [
  "💻", "✍️", "🎨", "📊", "🤖", "📣", "🛡️", "🔬", "✨", "📚",
  "🎬", "🎵", "🖼️", "📈", "💼", "🧠", "⚙️", "🌐", "📱", "🎮",
  "📝", "🔍", "💡", "🚀", "🧩", "🗂️", "📦", "🔐", "☁️", "🛠️",
];

export default function IconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-[38px] w-full items-center justify-between rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm outline-none focus:border-emerald-500"
      >
        <span className="text-base leading-none">{value || "—"}</span>
        <span className="text-[10px] text-zinc-500">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 grid w-full grid-cols-6 gap-1 rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-xl">
          <button
            type="button"
            onClick={() => { onChange(""); setOpen(false); }}
            className="flex h-8 items-center justify-center rounded text-[10px] text-zinc-500 hover:bg-zinc-800"
            title="无图标"
          >
            无
          </button>
          {ICON_CHOICES.map((ic) => (
            <button
              key={ic}
              type="button"
              onClick={() => { onChange(ic); setOpen(false); }}
              className={`flex h-8 items-center justify-center rounded text-base hover:bg-zinc-800 ${value === ic ? "bg-emerald-500/20 ring-1 ring-emerald-500" : ""}`}
            >
              {ic}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
