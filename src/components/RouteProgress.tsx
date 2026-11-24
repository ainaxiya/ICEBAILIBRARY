"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// ─── 整站路由加载进度条 ───
// 点击站内链接立即在顶部显示进度条，路由切换完成后收起；
// 解决「点了按钮/链接长时间无反馈，用户以为没点上」的问题。

export default function RouteProgress() {
  const pathname = usePathname();
  const [pct, setPct] = useState(0);
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(false);
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  const finish = () => {
    clearTimers();
    setPct(100);
    timers.current.push(
      window.setTimeout(() => {
        visibleRef.current = false;
        setVisible(false);
        setPct(0);
      }, 350)
    );
  };

  // 路由变化完成 → 收起
  useEffect(() => {
    if (visibleRef.current) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    const start = () => {
      clearTimers();
      visibleRef.current = true;
      setVisible(true);
      setPct(12);
      timers.current.push(window.setTimeout(() => setPct((p) => (p < 45 ? 45 : p)), 250));
      timers.current.push(window.setTimeout(() => setPct((p) => (p < 78 ? 78 : p)), 1200));
      // 兜底：导航一直未完成（如被拦截）也自动收起
      timers.current.push(window.setTimeout(() => finish(), 8000));
    };

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a");
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (!href || href.startsWith("#") || a.target === "_blank" || a.hasAttribute("download")) return;
      if (a.origin && a.origin !== window.location.origin) return;
      // 同页链接（如会员中心回首页事件）不显示进度条
      if (a.pathname + a.search === window.location.pathname + window.location.search) return;
      start();
    };

    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5" aria-hidden="true">
      <div
        className="h-full bg-gradient-to-r from-emerald-400 to-sky-400 shadow-[0_0_8px_rgba(16,185,129,0.7)] transition-[width] duration-300 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
