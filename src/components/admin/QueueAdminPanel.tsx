"use client";

// 队列与并发后台：三栏 TAB（消费线状态 / 消费线设置 / 实验场维护开关）。
// TAB 写入 URL hash，刷新后保持；移动端横向滚动；字号 ≥12px。
import { useCallback, useEffect, useState } from "react";
import QueueStatusPanel, { type QueueSnapshot } from "./QueueStatusPanel";
import QueueSettingsForm from "./QueueSettingsForm";
import QueueMaintenancePanel from "./QueueMaintenancePanel";

const TABS = [
  { key: "status", label: "消费线状态" },
  { key: "settings", label: "消费线设置" },
  { key: "maintenance", label: "实验场维护开关" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function QueueAdminPanel() {
  const [tab, setTab] = useState<TabKey>("status");
  const [snap, setSnap] = useState<QueueSnapshot | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const h = window.location.hash.replace(/^#/, "");
    if (TABS.some((t) => t.key === h)) setTab(h as TabKey);
  }, []);

  const switchTab = (key: TabKey) => {
    setTab(key);
    window.history.replaceState(null, "", `#${key}`);
  };

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const r = await fetch("/api/admin/ops/queue-status");
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "加载失败");
        return;
      }
      setError("");
      setSnap(d as QueueSnapshot);
    } catch {
      setError("加载失败，请稍后重试");
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="space-y-4">
      {/* TAB 导航 */}
      <div className="flex flex-nowrap gap-1.5 overflow-x-auto rounded-xl border border-zinc-700 bg-zinc-900/60 p-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchTab(t.key)}
            className={
              "shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition " +
              (tab === t.key
                ? "bg-sky-500 font-medium text-white"
                : "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "status" && (
        <QueueStatusPanel
          snap={snap}
          error={error}
          refreshing={refreshing}
          onRefresh={() => void load(true)}
        />
      )}
      {tab === "settings" && <QueueSettingsForm />}
      {tab === "maintenance" && (
        <QueueMaintenancePanel snap={snap} error={error} reload={() => void load(true)} />
      )}
    </div>
  );
}
