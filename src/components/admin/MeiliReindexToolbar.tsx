"use client";

import { useEffect, useRef, useState } from "react";

// 搜索管理页顶部工具条：「搜索数据全更新」按钮
// 点击后触发 /api/admin/meili-reindex 执行 node scripts/reindex-meili.mjs 全量重建
// 进行中每 2 秒轮询状态，展示日志尾部

type Status = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  log: string;
};

// fetch 超时（AbortController）：防止接口异常时页面一直处于"等待"状态
async function fetchJSON(url: string, init?: RequestInit): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(url, { ...init, cache: "no-store", signal: ctl.signal });
    return await r.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }
}

export default function MeiliReindexToolbar() {
  const [status, setStatus] = useState<Status | null>(null);
  const [msg, setMsg] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = async () => {
    try {
      const d = await fetchJSON("/api/admin/meili-reindex");
      if (!d) return; // 超时/失败静默，下一轮再试
      setStatus(d);
      if (!d.running && timer.current) {
        clearInterval(timer.current);
        timer.current = null;
        if (d.ok === true) setMsg("搜索数据全更新完成");
        else if (d.ok === false) setMsg("重建过程中出现错误，请看日志");
      }
    } catch {
      // 轮询失败静默，下一轮再试
    }
  };

  useEffect(() => {
    // 进入页面先同步一次状态（可能是刷新前启动的任务）
    poll();
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    setMsg("");
    try {
      const d = await fetchJSON("/api/admin/meili-reindex", { method: "POST" });
      if (!d) {
        setMsg("启动失败：请求超时，请稍后重试");
        return;
      }
      if (d.error) {
        setMsg(d.error);
        return;
      }
      setMsg("已开始全量重建…");
      setStatus((s) => ({ ...(s as Status), running: true, ok: null }));
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(poll, 2000);
    } catch {
      setMsg("启动失败，请稍后重试");
    }
  };

  const running = !!status?.running;
  const lastLine = (status?.log || "").trim().split("\n").filter(Boolean).pop() || "";

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={start}
          disabled={running}
          className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-b from-emerald-500 to-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-[0_8px_20px_-8px_rgba(16,185,129,0.6)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running && (
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          搜索数据全更新
        </button>
        <div className="min-w-0 flex-1 text-xs text-zinc-400">
          {running ? (
            <span className="text-emerald-300">正在全量重建 MeiliSearch 索引（提示词 / AI技能 / AI软件）…</span>
          ) : status?.ok === true ? (
            <span className="text-emerald-400">{msg || "上次重建成功"}</span>
          ) : status?.ok === false ? (
            <span className="text-rose-400">{msg || "上次重建出错"}</span>
          ) : (
            <span>{msg || "把数据库内容全量推送到搜索索引，数据不一致时点这个"}</span>
          )}
          {lastLine && (
            <div className="mt-1 truncate font-mono text-[11px] text-zinc-500">{lastLine}</div>
          )}
        </div>
      </div>
    </div>
  );
}
