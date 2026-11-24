"use client";

// 实验场维护开关 TAB：维护模式 + 实验场总开关 + 重启消费进程。
import { useEffect, useRef, useState } from "react";
import type { QueueSnapshot } from "./QueueStatusPanel";

type PlaygroundSettings = { enabled?: boolean } & Record<string, unknown>;

function fmtTime(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

const cardCls = "rounded-xl border border-zinc-700 bg-zinc-900/50 p-4";
const titleCls = "text-sm font-semibold text-zinc-100";
const hintCls = "mt-1 text-xs leading-relaxed text-zinc-300";

export default function QueueMaintenancePanel({
  snap,
  error,
  reload,
}: {
  snap: QueueSnapshot | null;
  error: string;
  reload: () => void;
}) {
  // 维护开关
  const [maintMsg, setMaintMsg] = useState("");
  const [maintBusy, setMaintBusy] = useState(false);
  const [maintTip, setMaintTip] = useState("");
  const initRef = useRef(false);

  // 实验场总开关
  const [rules, setRules] = useState<PlaygroundSettings | null>(null);
  const [rulesBusy, setRulesBusy] = useState(false);
  const [rulesTip, setRulesTip] = useState("");
  const [rulesErr, setRulesErr] = useState("");

  // 重启
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartMsg, setRestartMsg] = useState("");
  const [restartErr, setRestartErr] = useState("");
  const [restarting, setRestarting] = useState(false);
  const prevStartedAtRef = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!initRef.current && snap) {
      initRef.current = true;
      setMaintMsg(snap.maintenance.message || "");
    }
  }, [snap]);

  useEffect(() => {
    fetch("/api/admin/playground/settings")
      .then((r) => r.json())
      .then((d: PlaygroundSettings) => setRules(d))
      .catch(() => setRulesErr("实验场总开关读取失败"));
  }, []);

  // 重启完成判定：心跳里的进程启动时间变了，说明新进程已上线
  useEffect(() => {
    if (!restarting || !snap) return;
    const started = snap.worker.startedAt;
    if (snap.worker.online && started && started !== prevStartedAtRef.current) {
      setRestarting(false);
      setRestartMsg("重启完成，新进程已上线；可以关闭实验场维护了。");
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    }
  }, [restarting, snap]);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    []
  );

  const toggleMaintenance = async () => {
    if (!snap || maintBusy) return;
    setMaintBusy(true);
    setMaintTip("");
    try {
      const r = await fetch("/api/admin/ops/maintenance", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !snap.maintenance.enabled, message: maintMsg.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok) {
        setMaintTip(d.error || "维护开关保存失败");
        return;
      }
      setMaintTip(
        snap.maintenance.enabled
          ? "已关闭维护：前台恢复接单。"
          : "已开启维护：前台立刻停止接收新任务，已在跑的任务会继续跑完。"
      );
      reload();
    } catch {
      setMaintTip("维护开关保存失败");
    } finally {
      setMaintBusy(false);
    }
  };

  const saveRules = async () => {
    if (!rules || rulesBusy) return;
    setRulesBusy(true);
    setRulesTip("");
    setRulesErr("");
    try {
      const r = await fetch("/api/admin/playground/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rules),
      });
      const d = (await r.json()) as PlaygroundSettings & { error?: string; notes?: string[] };
      if (!r.ok) throw new Error(d.error || "保存失败");
      setRules((prev) => (prev ? { ...prev, enabled: d.enabled ?? prev.enabled } : prev));
      setRulesTip(["已保存，前台刷新后生效。", ...(d.notes ?? [])].join(" "));
    } catch (e) {
      setRulesErr((e as Error).message);
    } finally {
      setRulesBusy(false);
    }
  };

  const doRestart = async () => {
    if (!snap || restartBusy) return;
    if (reason.trim().length < 2) {
      setRestartErr("请填写重启原因（会写入审计日志）");
      return;
    }
    setRestartBusy(true);
    setRestartErr("");
    setRestartMsg("");
    try {
      const r = await fetch("/api/admin/ops/worker/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const d = await r.json();
      if (!r.ok) {
        setRestartErr(d.error || "重启失败");
        return;
      }
      prevStartedAtRef.current = snap.worker.startedAt;
      setRestarting(true);
      setConfirmOpen(false);
      setRestartMsg("重启指令已发送，正在等待新进程心跳…");
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        setRestarting(false);
        setRestartMsg("2 分钟内未等到新进程心跳，请检查 pm2 日志（pm2 logs CompletePrompt-Worker）。");
      }, 120_000);
    } catch {
      setRestartErr("重启失败，请稍后重试");
    } finally {
      setRestartBusy(false);
    }
  };

  const inflight = snap?.workerInflight ?? 0;
  const restartDisabledReason = !snap
    ? "状态读取中…"
    : !snap.canRestart
      ? "仅超级管理员可重启"
      : !snap.redisOk
        ? "Redis 不可用"
        : !snap.worker.online
          ? "消费进程心跳已过期（可能已退出）"
          : inflight > 0
            ? `还有 ${inflight} 个任务在跑`
            : "";

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-rose-400">{error}</p>}

      {/* 维护模式 */}
      <section className={cardCls}>
        <h3 className={titleCls}>实验场维护开关</h3>
        <p className={hintCls}>
          开启后前台实验场立即停止接收新任务并展示维护提示；
          <b className="text-zinc-100">已在跑的任务不受影响</b>，会继续跑完。状态存在配置表，重启不丢。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              snap?.maintenance.enabled
                ? "bg-amber-500/15 text-amber-300"
                : "bg-emerald-500/15 text-emerald-300"
            }`}
          >
            {!snap ? "读取中…" : snap.maintenance.enabled ? "维护中（不接新任务）" : "正常接单"}
          </span>
          <button
            type="button"
            disabled={maintBusy || !snap}
            onClick={toggleMaintenance}
            className={`rounded-lg px-3.5 py-2 text-xs font-medium text-white transition disabled:opacity-50 ${
              snap?.maintenance.enabled
                ? "bg-emerald-600 hover:bg-emerald-500"
                : "bg-amber-600 hover:bg-amber-500"
            }`}
          >
            {maintBusy
              ? "保存中…"
              : snap?.maintenance.enabled
                ? "关闭维护，恢复接单"
                : "开启维护，停止接单"}
          </button>
        </div>
        <label className="mt-4 block text-xs text-zinc-300">
          维护提示语（前台展示，最多 200 字）
          <textarea
            value={maintMsg}
            onChange={(e) => setMaintMsg(e.target.value)}
            rows={2}
            maxLength={200}
            placeholder="实验场正在升级，请稍后再试。"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-sky-500"
          />
        </label>
        {maintTip && <p className="mt-2 text-xs text-emerald-300">{maintTip}</p>}
        {snap?.maintenance.updatedAt && (
          <p className="mt-2 text-xs text-zinc-400">上次变更：{fmtTime(Date.parse(snap.maintenance.updatedAt))}</p>
        )}
      </section>

      {/* 实验场总开关 */}
      <section className={cardCls}>
        <h3 className={titleCls}>实验场总开关</h3>
        <p className={hintCls}>
          关闭后前台导航、页脚、手机底栏入口隐藏，直达 /playground 显示关闭提示，聊天与任务接口一律拒绝。
          与「维护模式」不同：维护只停接新任务，入口仍在。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              rules?.enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-300"
            }`}
          >
            {!rules ? "读取中…" : rules.enabled ? "实验场已开启" : "实验场已关闭"}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(rules?.enabled)}
            disabled={!rules}
            onClick={() => rules && setRules({ ...rules, enabled: !rules.enabled })}
            className={`rounded-lg px-3.5 py-2 text-xs font-medium text-white transition disabled:opacity-50 ${
              rules?.enabled ? "bg-amber-600 hover:bg-amber-500" : "bg-emerald-600 hover:bg-emerald-500"
            }`}
          >
            {rules?.enabled ? "关闭实验场" : "开启实验场"}
          </button>
          <button
            type="button"
            disabled={rulesBusy || !rules}
            onClick={() => void saveRules()}
            className="rounded-lg bg-sky-500 px-4 py-2 text-xs font-medium text-white transition hover:bg-sky-400 disabled:opacity-50"
          >
            {rulesBusy ? "保存中…" : "保存总开关"}
          </button>
          {rulesTip && <span className="text-xs text-emerald-300">{rulesTip}</span>}
          {rulesErr && <span className="text-xs text-red-300">{rulesErr}</span>}
        </div>
      </section>

      {/* 重启消费进程 */}
      <section className="rounded-xl border border-rose-800/60 bg-rose-500/5 p-4">
        <h3 className={titleCls}>重启消费进程（高危）</h3>
        <div className="mt-2 space-y-1 text-xs leading-relaxed text-zinc-300">
          <p className="text-zinc-200">什么情况下需要点：</p>
          <ul className="list-disc space-y-0.5 pl-5">
            <li>改了消费线数量（视频 / 图片 / 产物下载），这些是 Worker 启动时读取的。</li>
            <li>发版之后：Worker 产物需要与 web 同版本，重启一次让它加载新代码。</li>
            <li>服务假死但进程还在：心跳正常、任务却不动，先按「维护 → 归零 → 重启」处理。</li>
            <li>维护结束恢复接单：确认消费进程状态正常后再关闭维护。</li>
            <li>队列积压但心跳正常，怀疑假活（进程在、实际不消费）。</li>
          </ul>
          <p className="pt-1 text-zinc-400">
            平时不需要点。只重启 Worker，不重启 web、不动数据库；有任务在跑时按钮不可用。
          </p>
        </div>

        {snap?.maintenance.enabled && inflight > 0 && (
          <p className="mt-3 rounded-lg border border-amber-700/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            维护已开启，还有 {inflight} 个任务在跑。等在跑数归零后再重启。
          </p>
        )}
        {snap && !snap.maintenance.enabled && inflight > 0 && (
          <p className="mt-3 rounded-lg border border-zinc-700 bg-zinc-800/40 px-3 py-2 text-xs text-zinc-300">
            建议先开启实验场维护，等在跑数归零后再重启，避免重启期间有新任务进来。
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setConfirmOpen(true);
              setRestartErr("");
              setRestartMsg("");
            }}
            disabled={!!restartDisabledReason || restartBusy || restarting}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {restarting ? "重启中…" : "重启消费进程"}
          </button>
          {restartDisabledReason && <span className="text-xs text-zinc-400">{restartDisabledReason}</span>}
          {restartMsg && (
            <span className={`text-xs ${restarting ? "text-amber-300" : "text-emerald-400"}`}>{restartMsg}</span>
          )}
          {restartErr && <span className="text-xs text-rose-400">{restartErr}</span>}
        </div>

        {confirmOpen && (
          <div className="mt-3 rounded-lg border border-rose-800/60 bg-zinc-950/60 p-3">
            <p className="text-xs leading-relaxed text-zinc-200">
              确认重启消费进程？
              <span className="text-rose-300">重启期间不接收新任务，已在跑的任务会先跑完。</span>
              本次操作会记录审计日志（操作人、时间、原因）。
            </p>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="重启原因（必填，写入审计日志）"
              className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 outline-none focus:border-rose-500"
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={doRestart}
                disabled={restartBusy}
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-50"
              >
                {restartBusy ? "发送中…" : "确认重启"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                取消
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
