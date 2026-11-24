"use client";

import { useEffect, useState } from "react";

// ─── P6 #22 队列与并发设置 ───
// 后端 SiteSetting key="queue_config"；1–200 范围校验。
// 每项都写清「是什么 / 调大的代价 / 是否需要重启」，保存后单独提示需重启的项。

interface ChannelMeta {
  key: "video" | "audio" | "image" | "text" | "download";
  label: string;
  what: string;
  cost: string;
  restartRequired: boolean;
  effect: string;
}
type Config = Record<ChannelMeta["key"], number>;

const inputCls =
  "w-24 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 focus:border-emerald-500 focus:outline-none";

export default function QueueSettingsForm() {
  const [meta, setMeta] = useState<ChannelMeta[] | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [min, setMin] = useState(1);
  const [max, setMax] = useState(200);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [restart, setRestart] = useState<ChannelMeta[]>([]);

  useEffect(() => {
    fetch("/api/admin/settings/queue")
      .then((r) => r.json())
      .then((d) => {
        if (d.config) {
          setCfg(d.config);
          setMeta(d.meta || []);
          setMin(Number(d.min) || 1);
          setMax(Number(d.max) || 200);
        } else {
          setError(d.error || "加载失败");
        }
      })
      .catch(() => setError("加载失败，请稍后重试"));
  }, []);

  const setValue = (key: ChannelMeta["key"], raw: string) => {
    const n = Math.floor(Number(raw));
    setCfg((c) => (c ? { ...c, [key]: Number.isFinite(n) ? n : 0 } : c));
  };

  const save = async () => {
    if (!cfg || busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    setRestart([]);
    try {
      const r = await fetch("/api/admin/settings/queue", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      const d = await r.json();
      if (r.ok) {
        setCfg(d.config);
        setSaved(true);
        setRestart(Array.isArray(d.restartRequired) ? d.restartRequired : []);
      } else {
        setError(d.error || "保存失败");
      }
    } catch {
      setError("保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  if (!cfg || !meta) {
    return <p className="py-10 text-center text-zinc-300">{error || "加载中…"}</p>;
  }

  return (
    <div className="max-w-3xl">
      {error && <p className="mb-3 text-sm text-rose-400">{error}</p>}

      <div className="mb-4 rounded-xl border border-amber-700/40 bg-amber-500/5 p-4 text-xs leading-relaxed text-amber-200/90">
        视频、图片、产物下载三条线在 Worker 进程启动时读取并发，改完必须
        <span className="mx-1 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-amber-200">
          pm2 restart CompletePrompt-Worker
        </span>
        才生效；音频、文本是进程内闸门，保存后约 5 秒自动生效。
      </div>

      {saved && (
        <div className="mb-4 rounded-xl border border-emerald-700/40 bg-emerald-500/5 p-4 text-sm text-emerald-300">
          <p>已保存。</p>
          {restart.length > 0 ? (
            <p className="mt-1.5 text-amber-300">
              以下配置需要重启 Worker 进程后才会真正生效：
              <span className="mx-1 font-medium">{restart.map((m) => m.label).join("、")}</span>。
              请执行
              <span className="mx-1 rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs">
                pm2 restart CompletePrompt-Worker
              </span>
              ，不要以为保存后已经生效。
            </p>
          ) : (
            <p className="mt-1.5 text-emerald-400">本次改动均无需重启，约 5 秒内自动生效。</p>
          )}
        </div>
      )}

      <div className="space-y-4">
        {meta.map((m) => (
          <div key={m.key} className="rounded-xl border border-zinc-700 bg-zinc-900/50 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-zinc-200">{m.label}</h3>
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">{m.what}</p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={min}
                  max={max}
                  value={cfg[m.key]}
                  onChange={(e) => setValue(m.key, e.target.value)}
                  className={inputCls}
                />
                <span className="text-xs text-zinc-400">
                  范围 {min}–{max}
                </span>
              </div>
            </div>
            <div className="mt-3 space-y-1 border-t border-zinc-700/80 pt-3 text-xs leading-relaxed">
              <p className="text-zinc-400">
                <span className="text-zinc-400">调大的代价：</span>
                {m.cost}
              </p>
              <p className={m.restartRequired ? "text-amber-400/90" : "text-emerald-400/90"}>
                {m.effect}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "保存中…" : "保存并发设置"}
        </button>
        {saved && <span className="text-sm text-emerald-500">已保存 ✓</span>}
      </div>
    </div>
  );
}
