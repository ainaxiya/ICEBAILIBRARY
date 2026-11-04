"use client";

import { useEffect, useState } from "react";

// ─── API 文档页锚点目录（客户端小组件） ───
// 点击平滑滚动到对应章节；页面滚动时用 IntersectionObserver 高亮当前章节。
export default function ApiDocsTocNav({ items }: { items: { id: string; title: string }[] }) {
  const [active, setActive] = useState("");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-88px 0px -65% 0px", threshold: 0 }
    );
    for (const it of items) {
      const el = document.getElementById(it.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items]);

  return (
    <ul className="space-y-0.5">
      {items.map((it) => (
        <li key={it.id}>
          <a
            href={`#${it.id}`}
            className={`block rounded-md px-3 py-1.5 text-[13px] leading-relaxed transition ${
              active === it.id
                ? "bg-emerald-400/10 font-medium text-emerald-300"
                : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
            }`}
          >
            {it.title}
          </a>
        </li>
      ))}
    </ul>
  );
}
