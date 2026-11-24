"use client";

// ─── 后台「实验场」栏目 ───
// 已批准骨架：维护开关、虚拟角色头像、四类消费线数量，以及 pa 组运营规则
// （游客试玩、默认模型、锁定默认参数、参考素材上限）。其余实验场设置项不在此页提供入口。
import { useEffect, useRef, useState } from "react";
import QueueSettingsForm from "./QueueSettingsForm";

const card = "rounded-xl border border-zinc-700 bg-zinc-900/60 p-5";
const title = "text-sm font-semibold text-zinc-100";
const hint = "mt-1 text-xs leading-5 text-zinc-400";
const fieldHint = "mt-2 text-xs leading-5 text-zinc-400";
const fieldLabel = "mt-2 block text-xs text-zinc-300";

// TAB 顺序即页面信息架构：看板 → 规则 → 角色 → 消费线 → 维护
const TABS = [
  { key: "board", label: "运行看板" },
  { key: "rules", label: "实验场规则设置" },
  { key: "character", label: "虚拟角色设置" },
  { key: "consumers", label: "消费线与并发设置" },
  { key: "maintenance", label: "实验场维护开关" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

interface Maintenance {
  enabled: boolean;
  message: string;
  updatedAt?: string | null;
}

interface Avatar {
  url: string | null;
  isDefault: boolean;
  storage: "local" | "bucket" | null;
  key: string | null;
  updatedAt: string | null;
}

const EMPTY_AVATAR: Avatar = { url: null, isDefault: true, storage: null, key: null, updatedAt: null };

// pa33 运行看板（今日 onsite 调用聚合）
interface StatsModel {
  model: string;
  calls: number;
  successCalls: number;
  successRate: number;
}

interface Stats {
  day: string;
  calls: number;
  successCalls: number;
  successRate: number;
  avgLatencyMs: number | null;
  topModels: StatsModel[];
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const latencyText = (ms: number | null) => {
  if (ms === null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms} ms`;
};

// pa 组运营规则（与 /api/admin/playground/settings 同结构）
interface Rules {
  guest: { enabled: boolean; maxTrials: number };
  defaultModels: { image: string; video: string };
  lockDefaults: boolean;
  limits: { maxReferenceImages: number | null; maxReferenceVideos: number | null };
  upload: {
    imageMaxMB: number;
    videoMaxMB: number;
    imageFormats: string[];
    videoFormats: string[];
  };
  copy: { queued: string; running: string; failed: string; timeout: string };
  rateLimitNotice: string;
  // pa8 平台级人设提示词
  persona: string;
  // pa1 实验场总开关
  enabled: boolean;
  options?: {
    imageFormats: string[];
    videoFormats: string[];
    hardMaxImageMB: number;
    hardMaxVideoMB: number;
    personaMaxLen?: number;
  };
}

const EMPTY_RULES: Rules = {
  guest: { enabled: false, maxTrials: 3 },
  defaultModels: { image: "gpt-image-2", video: "doubao-seedance-2-5" },
  lockDefaults: false,
  limits: { maxReferenceImages: null, maxReferenceVideos: null },
  upload: {
    imageMaxMB: 10,
    videoMaxMB: 100,
    imageFormats: ["jpg", "png", "webp", "gif"],
    videoFormats: ["mp4", "webm"],
  },
  copy: {
    queued: "任务已提交，排队中…",
    running: "生成中",
    failed: "生成失败，预扣积分已全额退回",
    timeout: "任务超时，预扣积分已全额退回",
  },
  rateLimitNotice: "当前排队人数较多，请稍后再试",
  persona: "",
  enabled: true,
};

export default function PlaygroundAdminPanel() {
  // 当前 TAB（写入 URL hash，刷新后保持）
  const [tab, setTab] = useState<TabKey>("board");
  useEffect(() => {
    const h = window.location.hash.replace(/^#/, "");
    if (TABS.some((t) => t.key === h)) setTab(h as TabKey);
  }, []);
  const switchTab = (key: TabKey) => {
    setTab(key);
    window.history.replaceState(null, "", `#${key}`);
  };

  // 维护开关
  const [maint, setMaint] = useState<Maintenance | null>(null);
  const [msg, setMsg] = useState("");
  const [maintBusy, setMaintBusy] = useState(false);
  const [maintTip, setMaintTip] = useState("");

  // pa33 运行看板
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsErr, setStatsErr] = useState("");
  const [statsBusy, setStatsBusy] = useState(false);

  // 角色头像
  const [avatar, setAvatar] = useState<Avatar>(EMPTY_AVATAR);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarTip, setAvatarTip] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  // pa 组运营规则
  const [rules, setRules] = useState<Rules>(EMPTY_RULES);
  // 服务端已保存的基线：各栏保存时以基线为底，避免把其它栏未保存的草稿一起提交
  const [savedRules, setSavedRules] = useState<Rules | null>(null);
  const [rulesBusy, setRulesBusy] = useState(false);
  const [rulesTip, setRulesTip] = useState("");
  const [rulesErr, setRulesErr] = useState("");

  useEffect(() => {
    fetch("/api/admin/ops/maintenance")
      .then((r) => r.json())
      .then((d: Maintenance) => {
        setMaint(d);
        setMsg(d.message || "");
      })
      .catch(() => setMaintTip("维护状态读取失败"));
    fetch("/api/admin/playground/avatar")
      .then((r) => r.json())
      .then((d: Avatar) => setAvatar(d))
      .catch(() => setAvatarTip("头像状态读取失败"));
    fetch("/api/admin/playground/settings")
      .then((r) => r.json())
      .then((d: Rules) => {
        setRules(d);
        setSavedRules(d);
      })
      .catch(() => setRulesErr("运营规则读取失败"));
    fetch("/api/admin/playground/stats")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "统计读取失败");
        return d as Stats;
      })
      .then((d) => setStats(d))
      .catch((e: Error) => setStatsErr(e.message));
  }, []);

  async function loadStats() {
    setStatsBusy(true);
    setStatsErr("");
    try {
      const r = await fetch("/api/admin/playground/stats");
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "统计读取失败");
      setStats(d as Stats);
    } catch (e) {
      setStatsErr((e as Error).message);
    } finally {
      setStatsBusy(false);
    }
  }

  async function saveMaintenance(enabled: boolean) {
    setMaintBusy(true);
    setMaintTip("");
    try {
      const r = await fetch("/api/admin/ops/maintenance", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, message: msg.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "保存失败");
      setMaint(d);
      setMaintTip(enabled ? "已开启维护：前台立刻停止接收新任务，已在跑的任务会继续跑完。" : "已关闭维护：前台恢复接单。");
    } catch (e) {
      setMaintTip((e as Error).message);
    } finally {
      setMaintBusy(false);
    }
  }

  // 分栏保存：只把本栏字段叠加到「已保存基线」后提交，避免顺带保存其它栏的未保存草稿
  async function saveRulesSubset(partial: Partial<Rules>, tipText: string) {
    if (!savedRules) {
      setRulesErr("设置尚未加载完成");
      return;
    }
    setRulesBusy(true);
    setRulesTip("");
    setRulesErr("");
    const payload = { ...savedRules, ...partial };
    try {
      const r = await fetch("/api/admin/playground/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = (await r.json()) as Partial<Rules> & { error?: string; notes?: string[] };
      if (!r.ok) throw new Error(d.error || "保存失败");
      const nextSaved: Rules = { ...payload, ...d };
      setSavedRules(nextSaved);
      // 只把本栏字段的服务器回显写回表单，其它栏未保存的草稿保持不动
      const picked: Partial<Rules> = {};
      for (const k of Object.keys(partial) as (keyof Rules)[]) {
        (picked as unknown as Record<string, unknown>)[k] = (
          nextSaved as unknown as Record<string, unknown>
        )[k];
      }
      setRules((prev) => ({ ...prev, ...picked }));
      setRulesTip([tipText, ...(d.notes ?? [])].join(" "));
    } catch (e) {
      setRulesErr((e as Error).message);
    } finally {
      setRulesBusy(false);
    }
  }

  function saveRulesTab() {
    return saveRulesSubset(
      {
        guest: rules.guest,
        defaultModels: rules.defaultModels,
        lockDefaults: rules.lockDefaults,
        limits: rules.limits,
        upload: rules.upload,
        copy: rules.copy,
        rateLimitNotice: rules.rateLimitNotice,
      },
      "已保存运营规则，前台刷新后生效。"
    );
  }

  function savePersona() {
    return saveRulesSubset({ persona: rules.persona }, "人设已保存，前台刷新后生效。");
  }

  function saveEnabled() {
    return saveRulesSubset({ enabled: rules.enabled }, "实验场总开关已保存。");
  }

  async function uploadAvatar(file: File) {
    setAvatarBusy(true);
    setAvatarTip("");
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch("/api/admin/playground/avatar", { method: "POST", body: form });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "上传失败");
      const fresh = (await fetch("/api/admin/playground/avatar").then((x) => x.json())) as Avatar;
      setAvatar(fresh);
      setAvatarTip(`已保存（${d.storage === "bucket" ? "默认存储桶" : "本地 public/site-assets"}）：${d.url}`);
    } catch (e) {
      setAvatarTip((e as Error).message);
    } finally {
      setAvatarBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function clearAvatar() {
    setAvatarBusy(true);
    setAvatarTip("");
    try {
      const r = await fetch("/api/admin/playground/avatar", { method: "DELETE" });
      if (!r.ok) throw new Error("清除失败");
      setAvatar((await fetch("/api/admin/playground/avatar").then((x) => x.json())) as Avatar);
      setAvatarTip("已清除，前台回退默认角色形象（积分不足页角色插画）。");
    } catch (e) {
      setAvatarTip((e as Error).message);
    } finally {
      setAvatarBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* TAB 导航：移动端横向滚动，按钮不被挤压 */}
      <div className="flex gap-1 overflow-x-auto border-b border-zinc-700 pb-2 [&>*]:shrink-0">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchTab(t.key)}
            className={
              "whitespace-nowrap rounded-t-lg px-3 py-2 text-xs transition " +
              (tab === t.key
                ? "bg-indigo-600 text-white"
                : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 5. 维护开关（含实验场总开关） */}
      {tab === "maintenance" && (
      <section className={card}>
        <h3 className={title}>实验场维护开关</h3>
        <p className={hint}>
          开启后前台实验场立即停止接收新任务并展示维护提示；<b className="text-zinc-300">已在跑的任务不受影响</b>，会继续跑完。
          状态存在配置表，重启不丢。只在升级、排查故障、切换模型时临时开启，平时保持关闭。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              maint?.enabled ? "bg-amber-500/15 text-amber-300" : "bg-emerald-500/15 text-emerald-300"
            }`}
          >
            {maint ? (maint.enabled ? "维护中（不接新任务）" : "正常接单") : "读取中…"}
          </span>
          <button
            type="button"
            disabled={maintBusy || !maint}
            onClick={() => saveMaintenance(!maint?.enabled)}
            className={`rounded-lg px-3 py-2 text-xs font-medium text-white transition disabled:opacity-50 ${
              maint?.enabled ? "bg-emerald-600 hover:bg-emerald-500" : "bg-amber-600 hover:bg-amber-500"
            }`}
          >
            {maintBusy ? "保存中…" : maint?.enabled ? "关闭维护，恢复接单" : "开启维护，停止接单"}
          </button>
        </div>
        <label className="mt-4 block text-xs text-zinc-400">
          维护提示语（前台展示，最多 200 字）
          <textarea
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            rows={2}
            maxLength={200}
            placeholder="实验场正在升级，请稍后再试。"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 focus:border-emerald-500 focus:outline-none"
          />
        </label>
        {maintTip && <p className="mt-2 text-xs text-emerald-300">{maintTip}</p>}
      </section>
      )}

      {tab === "maintenance" && (
      <section className={card}>
        <h3 className={title}>实验场总开关</h3>
        <p className={hint}>
          关闭后前台导航、页脚、手机底栏入口隐藏，直达 /playground 显示关闭提示，聊天与任务接口一律拒绝。
          与「维护模式」不同：维护只停接新任务，入口仍在。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              rules.enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-300"
            }`}
          >
            {rules.enabled ? "实验场已开启" : "实验场已关闭"}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={rules.enabled}
            onClick={() => setRules({ ...rules, enabled: !rules.enabled })}
            className={`rounded-lg px-3 py-2 text-xs font-medium text-white transition ${
              rules.enabled ? "bg-amber-600 hover:bg-amber-500" : "bg-emerald-600 hover:bg-emerald-500"
            }`}
          >
            {rules.enabled ? "关闭实验场" : "开启实验场"}
          </button>
          <button
            type="button"
            disabled={rulesBusy}
            onClick={() => void saveEnabled()}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {rulesBusy ? "保存中…" : "保存总开关"}
          </button>
          {rulesTip && <span className="text-xs text-emerald-300">{rulesTip}</span>}
          {rulesErr && <span className="text-xs text-red-300">{rulesErr}</span>}
        </div>
      </section>
      )}

      {/* 1. 运行看板（今日） */}
      {tab === "board" && (
      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className={title}>运行看板（今日）</h3>
            <p className={hint}>
              统计口径：{stats?.day ?? "今日"}（北京时间自然日）实验场调用流水，含成功 / 失败 / 阻塞 / 取消。
              只读聚合，不影响计费与任务执行。
            </p>
          </div>
          <button
            type="button"
            disabled={statsBusy}
            onClick={loadStats}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
          >
            {statsBusy ? "刷新中…" : "刷新"}
          </button>
        </div>
        {statsErr && <p className="mt-2 text-xs text-red-400">{statsErr}</p>}
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
            <p className="text-xs text-zinc-400">调用量</p>
            <p className="mt-1 text-xl font-semibold text-zinc-100">{stats ? stats.calls : "—"}</p>
          </div>
          <div className="rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
            <p className="text-xs text-zinc-400">成功率</p>
            <p className="mt-1 text-xl font-semibold text-emerald-300">{stats ? pct(stats.successRate) : "—"}</p>
          </div>
          <div className="rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
            <p className="text-xs text-zinc-400">平均耗时</p>
            <p className="mt-1 text-xl font-semibold text-zinc-100">{latencyText(stats?.avgLatencyMs ?? null)}</p>
          </div>
          <div className="rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
            <p className="text-xs text-zinc-400">成功 / 总调用</p>
            <p className="mt-1 text-xl font-semibold text-zinc-100">
              {stats ? `${stats.successCalls} / ${stats.calls}` : "—"}
            </p>
          </div>
        </div>
        <div className="mt-4">
          <p className="text-xs text-zinc-400">热门模型（按今日调用量）</p>
          {stats && stats.topModels.length > 0 ? (
            <ul className="mt-2 divide-y divide-zinc-800 rounded-lg border border-zinc-700 bg-zinc-950/50">
              {stats.topModels.map((m) => (
                <li key={m.model} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <span className="truncate text-zinc-300">{m.model}</span>
                  <span className="shrink-0 text-zinc-400">
                    {m.calls} 次 · 成功 {pct(m.successRate)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-zinc-400">{stats ? "今日暂无实验场调用记录。" : "读取中…"}</p>
          )}
        </div>
      </section>
      )}

      {/* 2. 实验场规则设置 */}
      {tab === "rules" && (
      <section className={card}>
        <h3 className={title}>实验场运营规则</h3>
        <p className={hint}>
          模型全部开放，不做白名单；这里只定默认模型、游客试玩、参数锁定与参考素材上限。改动保存后前台刷新即生效。
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
            <label className="flex items-center justify-between text-xs text-zinc-300">
              <span>游客试玩</span>
              <input
                type="checkbox"
                checked={rules.guest.enabled}
                onChange={(e) => setRules({ ...rules, guest: { ...rules.guest, enabled: e.target.checked } })}
                className="h-4 w-4 accent-emerald-500"
              />
            </label>
            <label className="mt-3 block text-xs text-zinc-400">
              游客可试玩次数（0–50）
              <input
                type="number"
                min={0}
                max={50}
                value={rules.guest.maxTrials}
                onChange={(e) =>
                  setRules({ ...rules, guest: { ...rules.guest, maxTrials: Number(e.target.value) } })
                }
                disabled={!rules.guest.enabled}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
              />
            </label>
            <p className="mt-2 text-xs leading-5 text-zinc-400">
              关闭时页面仍然公开可浏览；游客发送消息、上传素材、调整参数、生成都会提示登录或注册，并给出登录/注册入口。
              开启后按 IP 计数放行，用尽同样引导登录。
            </p>
          </div>

          <div className="rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
            <label className="flex items-center justify-between text-xs text-zinc-300">
              <span>锁定为默认参数</span>
              <input
                type="checkbox"
                checked={rules.lockDefaults}
                onChange={(e) => setRules({ ...rules, lockDefaults: e.target.checked })}
                className="h-4 w-4 accent-emerald-500"
              />
            </label>
            <p className="mt-2 text-xs leading-5 text-zinc-400">
              锁定后所有会员只能按默认值生成：图片固定 1080 · 16:9 · 1 张；视频固定 720p · 16:9 · 5 秒，
              有声/无声按模型能力。未锁定时会员可自由调整，但仍受模型能力约束。
            </p>
          </div>

          <div className="rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
            <span className="text-xs text-zinc-300">默认模型</span>
            <label className="mt-2 block text-xs text-zinc-400">
              图片
              <input
                value={rules.defaultModels.image}
                onChange={(e) =>
                  setRules({ ...rules, defaultModels: { ...rules.defaultModels, image: e.target.value } })
                }
                placeholder="gpt-image-2"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <label className="mt-2 block text-xs text-zinc-400">
              视频
              <input
                value={rules.defaultModels.video}
                onChange={(e) =>
                  setRules({ ...rules, defaultModels: { ...rules.defaultModels, video: e.target.value } })
                }
                placeholder="doubao-seedance-2-5"
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <p className="mt-2 text-xs leading-5 text-zinc-400">
              必须与模型库里的名称一致且已上线。只影响默认选中与排序，不限制其它模型使用。
            </p>
          </div>

          <div className="rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
            <span className="text-xs text-zinc-300">参考素材上限</span>
            <label className="mt-2 block text-xs text-zinc-400">
              参考图（张，留空 = 按模型能力）
              <input
                type="number"
                min={0}
                max={30}
                value={rules.limits.maxReferenceImages ?? ""}
                onChange={(e) =>
                  setRules({
                    ...rules,
                    limits: {
                      ...rules.limits,
                      maxReferenceImages: e.target.value === "" ? null : Number(e.target.value),
                    },
                  })
                }
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <label className="mt-2 block text-xs text-zinc-400">
              参考视频（个，留空 = 按模型能力）
              <input
                type="number"
                min={0}
                max={10}
                value={rules.limits.maxReferenceVideos ?? ""}
                onChange={(e) =>
                  setRules({
                    ...rules,
                    limits: {
                      ...rules.limits,
                      maxReferenceVideos: e.target.value === "" ? null : Number(e.target.value),
                    },
                  })
                }
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <p className="mt-2 text-xs leading-5 text-zinc-400">
              只能在模型能力内下调，不允许调高；输入超出模型上限时保存会按上限截断并提示。
            </p>
          </div>

          <div className="rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
            <span className="text-xs text-zinc-300">上传格式与体积</span>
            <label className="mt-2 block text-xs text-zinc-400">
              图片单张上限（MB，硬上限 {rules.options?.hardMaxImageMB ?? 50}）
              <input
                type="number"
                min={1}
                max={rules.options?.hardMaxImageMB ?? 50}
                value={rules.upload.imageMaxMB}
                onChange={(e) =>
                  setRules({
                    ...rules,
                    upload: { ...rules.upload, imageMaxMB: Number(e.target.value) || 1 },
                  })
                }
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <label className="mt-2 block text-xs text-zinc-400">
              视频单个上限（MB，硬上限 {rules.options?.hardMaxVideoMB ?? 500}）
              <input
                type="number"
                min={1}
                max={rules.options?.hardMaxVideoMB ?? 500}
                value={rules.upload.videoMaxMB}
                onChange={(e) =>
                  setRules({
                    ...rules,
                    upload: { ...rules.upload, videoMaxMB: Number(e.target.value) || 1 },
                  })
                }
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <div className="mt-2 text-xs text-zinc-400">
              允许的图片格式
              <div className="mt-1 flex flex-wrap gap-3">
                {(rules.options?.imageFormats ?? ["jpg", "png", "webp", "gif"]).map((f) => (
                  <label key={f} className="flex items-center gap-1.5 text-zinc-300">
                    <input
                      type="checkbox"
                      checked={rules.upload.imageFormats.includes(f)}
                      onChange={(e) =>
                        setRules({
                          ...rules,
                          upload: {
                            ...rules.upload,
                            imageFormats: e.target.checked
                              ? [...rules.upload.imageFormats, f]
                              : rules.upload.imageFormats.filter((x) => x !== f),
                          },
                        })
                      }
                      className="accent-emerald-500"
                    />
                    {f === "jpg" ? "JPG" : f.toUpperCase()}
                  </label>
                ))}
              </div>
            </div>
            <div className="mt-2 text-xs text-zinc-400">
              允许的视频格式
              <div className="mt-1 flex flex-wrap gap-3">
                {(rules.options?.videoFormats ?? ["mp4", "webm"]).map((f) => (
                  <label key={f} className="flex items-center gap-1.5 text-zinc-300">
                    <input
                      type="checkbox"
                      checked={rules.upload.videoFormats.includes(f)}
                      onChange={(e) =>
                        setRules({
                          ...rules,
                          upload: {
                            ...rules.upload,
                            videoFormats: e.target.checked
                              ? [...rules.upload.videoFormats, f]
                              : rules.upload.videoFormats.filter((x) => x !== f),
                          },
                        })
                      }
                      className="accent-emerald-500"
                    />
                    {f.toUpperCase()}
                  </label>
                ))}
              </div>
            </div>
            <p className="mt-2 text-xs leading-5 text-zinc-400">
              格式按文件真实内容识别，改扩展名无效；MOV 按 MP4 识别。全部取消勾选将关闭该类素材上传。
            </p>
          </div>

          <div className="rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
            <span className="text-xs text-zinc-300">任务状态文案</span>
            {[
              { key: "queued", label: "排队中" },
              { key: "running", label: "生成中" },
              { key: "failed", label: "失败" },
              { key: "timeout", label: "超时" },
            ].map(({ key, label }) => (
              <label key={key} className="mt-2 block text-xs text-zinc-400">
                {label}
                <input
                  type="text"
                  maxLength={60}
                  value={rules.copy[key as keyof Rules["copy"]]}
                  onChange={(e) =>
                    setRules({
                      ...rules,
                      copy: { ...rules.copy, [key]: e.target.value },
                    })
                  }
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none"
                />
              </label>
            ))}
            <p className="mt-2 text-xs leading-5 text-zinc-400">
              只影响实验场任务气泡文案，不改变任务状态与结算；留空保存会回退默认文案。
            </p>
          </div>

          <div className="rounded-lg border border-zinc-700 bg-zinc-950/50 p-3">
            <span className="text-xs text-zinc-300">限流提示语</span>
            <label className="mt-2 block text-xs text-zinc-400">
              高峰排队 / 调用过频时返回的提示（60 字以内）
              <input
                type="text"
                maxLength={60}
                value={rules.rateLimitNotice}
                onChange={(e) => setRules({ ...rules, rateLimitNotice: e.target.value })}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none"
              />
            </label>
            <p className="mt-2 text-xs leading-5 text-zinc-400">
              仅用于实验场会员被日次数 / 每分钟次数限流时的可见提示；并发上限与游客试玩提示仍保留各自的具体说明。留空回退默认。
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={rulesBusy}
            onClick={() => void saveRulesTab()}
            className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {rulesBusy ? "保存中…" : "保存运营规则"}
          </button>
          {rulesTip && <span className="text-xs text-emerald-300">{rulesTip}</span>}
          {rulesErr && <span className="text-xs text-red-300">{rulesErr}</span>}
        </div>
      </section>
      )}

      {/* 3. 虚拟角色设置（人设 + 头像） */}
      {tab === "character" && (
      <section className={card}>
        <h3 className={title}>虚拟角色设置</h3>
        <p className={hint}>
          实验场对话统一使用这里的人设与形象；人设作为 system 提示注入，头像用于前台角色展示。
        </p>
        <div className="mt-4 rounded-lg border border-zinc-700 bg-zinc-950/60 p-3">
          <span className="text-xs font-medium text-zinc-200">平台级人设提示词（语气与边界）</span>
          <label className={fieldLabel}>
            作为 system 提示统一注入实验场对话；留空 = 不额外注入，沿用模型通用系统提示
            <textarea
              value={rules.persona}
              onChange={(e) => setRules({ ...rules, persona: e.target.value })}
              rows={6}
              maxLength={rules.options?.personaMaxLen ?? 4000}
              placeholder="例如：你是冰山 AI 助手，回答简洁、专业，遇到违法或越权请求时礼貌拒绝并说明原因。"
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 focus:border-emerald-500 focus:outline-none"
            />
          </label>
          <p className={fieldHint}>
            与技能素材同时存在时，平台人设置顶、技能素材随后。
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={rulesBusy}
              onClick={() => void savePersona()}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {rulesBusy ? "保存中…" : "保存人设"}
            </button>
            {rulesTip && <span className="text-xs text-emerald-300">{rulesTip}</span>}
            {rulesErr && <span className="text-xs text-red-300">{rulesErr}</span>}
          </div>
        </div>

        <h3 className={title + " mt-6"}>虚拟角色头像</h3>
        <p className={hint}>
          前台实验场把这张图作为角色形象（替代原来的实验图标）；未设置时使用默认占位图。
          支持 PNG / JPEG / WebP，单张不超过 2MB。存储沿用后台上传规则：默认桶已配置（且有公开访问域名）则进默认桶，否则落本地
          <code className="mx-1 rounded bg-zinc-800 px-1">public/site-assets</code>。改动后刷新前台即可看到。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950">
            {avatar.url ? (
              avatar.isDefault ? (
                <div
                  className="h-full w-full"
                  style={{
                    backgroundImage: `url(${avatar.url})`,
                    backgroundSize: "300%",
                    backgroundPosition: "75% 17%",
                    backgroundRepeat: "no-repeat",
                  }}
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatar.url} alt="角色头像" className="h-full w-full object-cover" />
              )
            ) : (
              <span className="text-xs text-zinc-400">未设置</span>
            )}
          </div>
          <div className="text-xs text-zinc-400">
            {avatar.isDefault ? (
              <>
                当前使用<b className="text-zinc-200">默认角色形象</b>
                <span className="block text-zinc-400">（积分不足页的角色插画，小尺寸按脸部区域裁切）</span>
              </>
            ) : (
              <>
                当前使用<b className="text-emerald-300">自定义头像</b>
                <span className="block break-all text-zinc-400">{avatar.url}</span>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 2 * 1024 * 1024) {
                  setAvatarTip("图片不能超过 2MB");
                  e.target.value = "";
                  return;
                }
                void uploadAvatar(f);
              }}
            />
            <button
              type="button"
              disabled={avatarBusy}
              onClick={() => fileRef.current?.click()}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {avatarBusy ? "处理中…" : avatar.isDefault ? "上传头像" : "更换头像"}
            </button>
            {!avatar.isDefault && (
              <button
                type="button"
                disabled={avatarBusy}
                onClick={clearAvatar}
                className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
              >
                清除
              </button>
            )}
          </div>
        </div>
        {avatarTip && <p className="mt-2 break-all text-xs text-emerald-300">{avatarTip}</p>}
      </section>
      )}

      {/* 4. 消费线与并发设置 */}
      {tab === "consumers" && (
      <section className={card}>
        <h3 className={title}>消费线与并发</h3>
        <p className={hint}>
          四类任务各走独立通道。视频 / 图片 / 产物下载的并发数在消费进程启动时读取，改完需要重启 Worker 才生效；
          音频 / 文本在 Web 进程内，保存后约 5 秒生效。
        </p>
        <div className="mt-4">
          <QueueSettingsForm />
        </div>
        <div className="mt-4 border-t border-zinc-700 pt-4">
          <a
            href="/guanli-7k2m9x/settings/queue"
            className="inline-flex items-center gap-1 text-xs text-sky-300 hover:text-sky-200 hover:underline"
          >
            查看消费线状态
          </a>
          <span className="ml-2 text-xs text-zinc-400">队列积压、负载与并发实时状态</span>
        </div>
      </section>
      )}
    </div>
  );
}
