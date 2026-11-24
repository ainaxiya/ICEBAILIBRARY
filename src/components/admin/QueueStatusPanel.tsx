"use client";

// 消费线状态展示：表头左右布局（左侧两行标题 + 进程状态，右侧天蓝刷新按钮）。
// 数据由父级 QueueAdminPanel 拉取传入，刷新仅重拉状态，不整页刷新。

export interface QueueChannel {
  key: string;
  label: string;
  scope: "worker" | "web";
  concurrency: number;
  running: number;
  idle: number;
  waiting: number;
  lastHeartbeatAt: number | null;
  online: boolean;
}

export interface QueueSnapshot {
  now: number;
  redisOk: boolean;
  worker: {
    online: boolean;
    lastSeenAt: number | null;
    pid: number | null;
    startedAt: number | null;
    uptimeSec: number | null;
    reportedInflight: number | null;
  };
  channels: QueueChannel[];
  workerInflight: number;
  maintenance: { enabled: boolean; message: string; updatedAt: string | null };
  canRestart?: boolean;
}

function relTime(ts: number | null, now: number): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={spinning ? "animate-spin" : ""}
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

export default function QueueStatusPanel({
  snap,
  error,
  refreshing,
  onRefresh,
}: {
  snap: QueueSnapshot | null;
  error: string;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  if (!snap) {
    return (
      <p className="py-8 text-center text-sm text-zinc-400">{error || "加载中…"}</p>
    );
  }

  const uptimeMin = snap.worker.uptimeSec != null ? Math.floor(snap.worker.uptimeSec / 60) : null;
  const inflight = snap.workerInflight;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-rose-400">{error}</p>}

      <section className="rounded-xl border border-zinc-700 bg-zinc-900/50">
        {/* 表头：左两行 / 右刷新按钮 */}
        <div className="flex items-center justify-between gap-3 border-b border-zinc-700 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">消费线状态</h2>
            <p className="mt-1 text-xs text-zinc-300">
              <span className={snap.worker.online ? "text-emerald-400" : "text-rose-400"}>
                ● 消费进程 {snap.worker.online ? "在线" : "离线"}
              </span>
              <span className="ml-3 text-zinc-300">
                已运行 {uptimeMin == null ? "—" : `${uptimeMin} 分钟`}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-sky-500 px-3.5 py-2 text-xs font-medium text-white transition hover:bg-sky-400 disabled:opacity-60"
          >
            <RefreshIcon spinning={refreshing} />
            刷新状态
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-zinc-400">
              <tr className="border-b border-zinc-700">
                <th className="px-4 py-2 font-normal">线路</th>
                <th className="px-3 py-2 font-normal">并发配置</th>
                <th className="px-3 py-2 font-normal">在跑</th>
                <th className="px-3 py-2 font-normal">空闲</th>
                <th className="px-3 py-2 font-normal">排队</th>
                <th className="px-3 py-2 font-normal">最后心跳</th>
                <th className="px-3 py-2 font-normal">状态</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {snap.channels.map((c) => (
                <tr key={c.key} className="border-b border-zinc-700/70 last:border-0">
                  <td className="px-4 py-2.5">
                    {c.label}
                    <span className="ml-1 text-zinc-400">
                      {c.scope === "web" ? "（Web 进程）" : "（Worker）"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">{c.concurrency}</td>
                  <td className="px-3 py-2.5">{c.running}</td>
                  <td className="px-3 py-2.5">{c.idle}</td>
                  <td className="px-3 py-2.5">{c.waiting}</td>
                  <td className="px-3 py-2.5 text-zinc-400">{relTime(c.lastHeartbeatAt, snap.now)}</td>
                  <td className="px-3 py-2.5">
                    <span className={c.online ? "text-emerald-400" : "text-rose-400"}>
                      {c.online ? "● 在线" : "● 离线"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-zinc-700 px-4 py-2 text-xs text-zinc-400">
          Worker 在跑合计 {inflight} 个（视频/图片/下载）。音频与文本在 Web 进程内消费，不进 Worker 队列。
        </p>
      </section>
    </div>
  );
}
