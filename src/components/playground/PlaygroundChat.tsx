"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { imageSize, type ImageRatio, type ImageResolution } from "@/lib/playground/media-spec";
import { explainApiError, type ErrorGuide } from "@/lib/error-guide";
import ApiErrorDialog from "@/components/ApiErrorDialog";
import SiteVideoPlayer from "@/components/media/SiteVideoPlayer";
import {
  durationOptions,
  type VideoCapability,
} from "@/lib/playground/video-capability";

// 与后端（route.ts / media-task-runner.ts）同一套硬约束：图片宽高 ≥300px、参考视频 ≤30s
const MIN_IMAGE_SIDE = 300;
const MAX_REFERENCE_VIDEO_SECONDS = 30;

// pa25：上传格式按后台配置的 kind 映射为 input accept；空数组 = 该类型禁止上传
const IMAGE_ACCEPT_BY_KIND: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};
const VIDEO_ACCEPT_BY_KIND: Record<string, string> = {
  mp4: "video/mp4,video/quicktime",
  webm: "video/webm",
};
const DEFAULT_UPLOAD_LIMITS = {
  imageMaxMB: 10,
  videoMaxMB: 100,
  imageFormats: ["jpg", "png", "webp", "gif"],
  videoFormats: ["mp4", "webm"],
};
// pa31：任务状态文案由后台下发，留空时使用这里兜底
const DEFAULT_TASK_COPY = {
  queued: "任务已提交，排队中…",
  running: "生成中",
  failed: "生成失败，预扣积分已全额退回",
  timeout: "任务超时，预扣积分已全额退回",
};

/** 读取本地图片宽高；解码失败返回 null（由调用方明确报错，不默认放过） */
async function probeImageSize(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const bmp = await createImageBitmap(file);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}

/** 读取本地视频时长（秒）；读不到返回 null */
function probeVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      resolve(value);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () =>
      done(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null);
    video.onerror = () => done(null);
    video.src = url;
  });
}

// ─── 冰山实验场：对话区（客户端） ───
// 与主站同源：登录态走主站 cookie，扣费走主站积分（/api/playground/chat），
// 界面上不展示任何「本次消耗 X 积分」提示，明细统一在会员中心查看。
// M2：会话落服务端（历史侧栏可切换/重命名/删除）+ 我的收藏一键带入。

export type ModelKind = "chat" | "image" | "video" | "audio";

export interface PlaygroundModel {
  id: number;
  name: string;
  displayName: string;
  remark: string | null;
  vendorName: string | null;
  kind: ModelKind;
  /** 模型库 capabilities.params 声明的参数键；空数组 = 未声明 */
  paramKeys: string[];
  declared: boolean;
  /** 端点与定价齐全，可实际发起生成 */
  ready: boolean;
  /** 图片模型的能力档位：未列入的档位在界面禁用（不发出去了才失败） */
  imageSpec?: { resolutions: string[]; ratios: string[]; note?: string } | null;
  /** 视频能力：完全来自模型库 advancedConfig（分辨率/比例/时长/素材/有声） */
  videoCap?: VideoCapability | null;
  /** 后台填写的统一秒价（积分/秒）；null = 未定价 */
  videoPricePerSecond?: number | null;
  /** 该模型系列的账户积分准入门槛（0/缺省 = 不限） */
  minBalanceCredits?: number;
}

// 从「推荐试一试」卡片带来的试用内容（?use=prompt-<id> / skill-<id>，服务端取好正文）
export interface PlaygroundInitialUse {
  kind: "prompt" | "skill";
  id: number;
  title: string;
  content: string;
  /** 提示词创作类型，决定可用模型（text | image | video | audio） */
  promptType?: "text" | "image" | "video" | "audio";
}

type Msg = {
  role: "user" | "assistant";
  content: string;
  images?: string[];
  /** 媒体任务 ID：有值时由轮询更新该条消息（刷新后也能恢复） */
  taskId?: string;
  /** 任务阶段（仅媒体任务） */
  task?: { status: string; progress: number; stage: string | null };
};
type SessionItem = { id: number; title: string; modelName: string; updatedAt: string };
type SessionMessage = {
  id: number;
  role: string;
  content: string;
  taskId?: string | null;
  media?: {
    status: string;
    progress: number;
    stage: string | null;
    urls: string[];
    error: string | null;
    size: string | null;
    latencyMs: number | null;
  } | null;
};
type FavPrompt = {
  id: number;
  title: string;
  category: string | null;
  content: string;
  type?: string;
};
type FavSkill = { id: number; name: string; slug: string; summary: string; content: string };

export const KIND_LABEL: Record<ModelKind, string> = {
  chat: "文本创作",
  image: "文生图",
  video: "文生视频",
  audio: "文生音频",
};

const MODEL_KINDS: ModelKind[] = ["chat", "image", "video", "audio"];

function kindOfPromptType(t?: string): ModelKind {
  return t === "image" || t === "video" || t === "audio" ? t : "chat";
}

const QUICK_STARTS = [
  "帮我写一份产品需求文档",
  "把这段话改写得更自然口语化",
  "用三个要点解释什么是提示词工程",
];

async function apiGet<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// 媒体任务（图/视频统一）：服务端 /api/playground/tasks 返回的结构
type MediaTaskView = {
  taskId: string;
  kind: string;
  model: string;
  status: string;
  progress: number;
  stage: string | null;
  size: string | null;
  prompt: string;
  urls: string[];
  error: string | null;
  latencyMs: number | null;
};

function taskText(
  t: MediaTaskView,
  copy: { queued: string; running: string; failed: string; timeout: string } = DEFAULT_TASK_COPY
): string {
  if (t.status === "queued") return copy.queued;
  if (t.status === "succeeded") {
    return `已完成 · ${t.size ?? ""}${t.latencyMs ? ` · ${(t.latencyMs / 1000).toFixed(1)}s` : ""}`;
  }
  if (t.status === "failed") {
    const timedOut = /超时|timeout/i.test(t.error ?? "");
    const base = timedOut ? copy.timeout : copy.failed;
    // 上游原始错误仍有参考价值，但不再让它顶掉后台配置的文案
    return t.error && t.error !== base ? `${base}（${t.error}）` : base;
  }
  const stage = t.stage && t.stage !== "生成中" ? ` · ${t.stage}` : "";
  return `${copy.running}${stage}${t.progress > 0 ? ` · ${t.progress}%` : ""}`;
}

// 比例图标：按宽高比画一个矩形轮廓，避免用文字标签堆满工具栏
function RatioIcon({ ratio }: { ratio: string }) {
  const [w, h] = ratio === "adaptive" ? [14, 10] : ratio.split(":").map(Number);
  const box = 16;
  const scale = Math.min(box / (w || 1), box / (h || 1));
  const rw = Math.max(5, Math.round((w || 1) * scale));
  const rh = Math.max(5, Math.round((h || 1) * scale));
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
      <span
        className="rounded-[2px] border border-current"
        style={{ width: rw, height: rh }}
      />
    </span>
  );
}

// 工具栏下拉：按钮 + 上浮菜单（比例带图标；时长可选 4…30 全数字，菜单可滚动）
function ToolMenu({
  value,
  options,
  onChange,
  disabled,
  title,
  className,
}: {
  value: string;
  options: { value: string; label: string; icon?: React.ReactNode }[];
  onChange: (v: string) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const open = pos !== null;
  const current = options.find((o) => o.value === value);

  useEffect(() => setMounted(true), []);

  // 定位用 fixed：输入框外层有 overflow 裁剪，absolute 上浮菜单会被聊天区切掉首项。
  // 上下空间都量一遍：优先向下展开，空间不够才向上，且高度夹在可视区内，绝不钻到搜索栏下面。
  function toggle() {
    if (open) {
      setPos(null);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const vh = window.innerHeight || 600;
    const width = 168;
    const left = Math.min(Math.max(8, rect.left), (window.innerWidth || 360) - width - 8);
    const below = vh - rect.bottom - 8;
    const above = rect.top - 8;
    if (below >= 120 || below >= above) {
      setPos({ left, top: rect.bottom + 4, maxHeight: Math.max(96, Math.min(264, below)) });
    } else {
      const maxHeight = Math.max(96, Math.min(264, above));
      setPos({ left, top: Math.max(8, rect.top - 4 - maxHeight), maxHeight });
    }
  }

  return (
    <div className={className ?? ""}>
      <button
        ref={btnRef}
        type="button"
        title={title}
        disabled={disabled}
        onClick={toggle}
        className={`inline-flex h-9 items-center gap-1 rounded-xl border px-2.5 text-xs font-medium transition-[border-color,background-color,color] duration-150 ${
          disabled
            ? "cursor-not-allowed border-zinc-800/70 text-zinc-600"
            : "border-zinc-700/70 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-900"
        } ${open ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" : ""}`}
      >
        {current?.icon}
        <span className="whitespace-nowrap">{current?.label ?? "—"}</span>
        <span className={`text-xs text-zinc-500 transition ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && mounted && pos
        ? createPortal(
            <>
              {/* 遮罩与菜单必须 portal 到 body：输入区祖先带 transform（触点/动画），
                  会让 fixed 以该祖先为参照系，菜单被推到视口外，表现为「点了没反应」。 */}
              <button
                type="button"
                aria-label="收起选项"
                tabIndex={-1}
                className="fixed inset-0 z-[80] cursor-default"
                onClick={() => setPos(null)}
              />
              <ul
                className="fixed z-[81] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-2xl"
                style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight, minWidth: 152 }}
              >
                {options.map((o) => (
                  <li key={o.value}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange(o.value);
                        setPos(null);
                      }}
                      className={`flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-xs ${
                        o.value === value
                          ? "bg-emerald-500/10 text-emerald-300"
                          : "text-zinc-300 hover:bg-zinc-800"
                      }`}
                    >
                      {o.icon}
                      <span className="flex-1">{o.label}</span>
                      {o.value === value && <span className="text-emerald-400">✓</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </>,
            document.body
          )
        : null}
    </div>
  );
}

// 首尾帧 / 参考素材上传胶囊：虚线边框，未上传时是入口，已上传时给缩略预览
function MediaChip({
  label,
  accept,
  url,
  uploading,
  disabled,
  hint,
  onPick,
  onClear,
}: {
  label: string;
  accept: string;
  url: string | null;
  uploading: boolean;
  disabled?: boolean;
  hint?: string;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const isVideo = accept.startsWith("video/");
  return (
    <span className="inline-flex items-center gap-1.5">
      <label
        title={hint}
        className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-dashed px-2.5 text-xs transition ${
          disabled
            ? "cursor-not-allowed border-zinc-800 text-zinc-600"
            : url
              ? "border-emerald-500/50 bg-emerald-500/5 text-emerald-300"
              : "border-zinc-600 text-zinc-400 hover:border-emerald-500/60 hover:text-emerald-300"
        }`}
      >
        <span className="text-xs leading-none">{isVideo ? "▤" : "▣"}</span>
        {uploading ? "上传中…" : label}
        <input
          type="file"
          accept={accept}
          className="hidden"
          disabled={disabled || uploading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            e.currentTarget.value = "";
          }}
        />
      </label>
      {url && (
        <span className="relative inline-flex">
          {isVideo ? (
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 text-xs text-zinc-300">
              视频
            </span>
          ) : (
            <img
              src={url}
              alt={label}
              className="h-8 w-8 rounded-md border border-zinc-700 object-cover"
            />
          )}
          <button
            type="button"
            aria-label={`移除${label}`}
            onClick={onClear}
            className="absolute -right-1 -top-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900 text-xs text-zinc-300 hover:border-red-500/60 hover:text-red-300"
          >
            ✕
          </button>
        </span>
      )}
    </span>
  );
}

// 轻量渲染：代码块 + 保留换行（够用且不引入额外依赖）
function RichText({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre
            key={i}
            className="my-2 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/80 p-3 text-xs leading-relaxed text-zinc-300"
          >
            <code>{part.replace(/^[a-zA-Z0-9+#.-]*\n/, "")}</code>
          </pre>
        ) : (
          <span key={i} className="whitespace-pre-wrap">
            {part}
          </span>
        )
      )}
    </>
  );
}

type PromptSegment = { no: number; text: string };

// 多段提示词：正文用 [1] / [2] … 标段（与列表页 sectionCount 同一口径）。
// 少于 2 段视为单段，保持整段带入；2 段以上改为分段插入，避免整段糊进输入框。
function parseSegments(content: string): PromptSegment[] {
  const markers = [...content.matchAll(/^\[(\d+)\][ \t]*/gm)];
  if (markers.length < 2) return [];
  const out: PromptSegment[] = [];
  for (let i = 0; i < markers.length; i++) {
    const start = (markers[i].index ?? 0) + markers[i][0].length;
    const end = i + 1 < markers.length ? (markers[i + 1].index ?? content.length) : content.length;
    const text = content.slice(start, end).trim();
    if (text) out.push({ no: Number(markers[i][1]), text });
  }
  return out.length >= 2 ? out : [];
}

function timeAgo(iso: string) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const minutes = Math.floor((Date.now() - t) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(t).toLocaleDateString("zh-CN");
}

// 实验场标识：用「播放/体验」图形替代原来的 🧪（易被误读为打针），与后台图标风格一致
function PlaygroundMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.6l5 3.4-5 3.4z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function PlaygroundChat({
  models,
  loggedIn,
  initialUse,
  balance = null,
  maintenance = null,
  avatarUrl = null,
  avatarIsDefault = true,
  guestTrial = { enabled: false, maxTrials: 0 },
  defaultModels = { image: "gpt-image-2", video: "doubao-seedance-2-5" },
  lockDefaults = false,
  referenceLimits = { maxReferenceImages: null, maxReferenceVideos: null },
  uploadLimits = DEFAULT_UPLOAD_LIMITS,
  taskCopy = DEFAULT_TASK_COPY,
}: {
  models: PlaygroundModel[];
  loggedIn: boolean;
  initialUse?: PlaygroundInitialUse | null;
  /** 当前积分余额（服务端下发；null = 未登录或未知） */
  balance?: number | null;
  /** 实验场维护开关（服务端下发）：开启后只停止接新任务，已在跑的任务不受影响 */
  maintenance?: { enabled: boolean; message: string } | null;
  /** 虚拟角色头像（后台可换；未上传时服务端下发默认角色插画） */
  avatarUrl?: string | null;
  /** true = 当前用的是默认插画（半身图），小尺寸展示时按脸部区域放大裁切 */
  avatarIsDefault?: boolean;
  /** 游客试玩（后台配置）：未开启时游客只能浏览，任何交互都引导登录/注册 */
  guestTrial?: { enabled: boolean; maxTrials: number };
  /** 后台设定的默认图片 / 视频模型 */
  defaultModels?: { image: string; video: string };
  /** 后台「锁定为默认」：锁定后会员只能按默认参数生成 */
  lockDefaults?: boolean;
  /** 参考素材上限（后台只能下调；null = 按模型能力） */
  referenceLimits?: { maxReferenceImages: number | null; maxReferenceVideos: number | null };
  /** 上传格式与体积上限（后台可配，pa25） */
  uploadLimits?: {
    imageMaxMB: number;
    videoMaxMB: number;
    imageFormats: string[];
    videoFormats: string[];
  };
  /** 任务状态文案（后台可配，pa31） */
  taskCopy?: { queued: string; running: string; failed: string; timeout: string };
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(models[0]?.name || "");
  const [busy, setBusy] = useState(false);
  // 游客：剩余试玩次数（服务端按 IP 计数；未开启试玩时为 0）
  const [guestRemaining, setGuestRemaining] = useState<number | null>(null);
  const [showParams, setShowParams] = useState(false);
  // 模型提示：浮动气泡显示几秒后自动消失，不占版面
  const [hintOpen, setHintOpen] = useState(false);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [error, setError] = useState<string | null>(null);
  // b7：失败原因弹窗（错误码 → 人话 → 建议动作）
  const [errorGuide, setErrorGuide] = useState<ErrorGuide | null>(null);
  // 服务端下发的余额快照；上传前会用 /api/playground/balance 再核一次，避免用过期余额放行
  const [balanceNow, setBalanceNow] = useState<number | null>(balance);

  useEffect(() => setBalanceNow(balance), [balance]);

  // 游客：拉取剩余试玩次数（后台未开启试玩时服务端返回 0）
  useEffect(() => {
    if (loggedIn) return;
    let alive = true;
    fetch("/api/playground/guest", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { remaining?: number }) => {
        if (alive) setGuestRemaining(typeof d.remaining === "number" ? d.remaining : 0);
      })
      .catch(() => {
        if (alive) setGuestRemaining(0);
      });
    return () => {
      alive = false;
    };
  }, [loggedIn]);

  // 游客可交互判定：未登录且（未开启试玩 或 次数已用尽）；
  // 次数还没拿到时先放行，由服务端按 IP 最终判定，避免页面初次渲染就误拦。
  const guestBlocked =
    !loggedIn && (!guestTrial.enabled || (guestRemaining != null && guestRemaining <= 0));

  // 游客点击任何交互入口：不弹提示层，直接去登录页；
  // next 带上当前实验场完整路径（含 ?use= 等参数），登录后原路返回。
  function goAuth() {
    const next = `${window.location.pathname}${window.location.search}` || "/playground";
    window.location.href = `/login?next=${encodeURIComponent(next)}`;
  }

  // 需要登录的交互统一走这里：游客直接跳登录/注册，已登录会员不受影响
  function blockGuest(): boolean {
    if (!guestBlocked) return false;
    goAuth();
    return true;
  }

  // 任何积分不足的统一出口：跳独立积分不足页（不在对话里弹小字）
  function goInsufficient(need?: number | null) {
    const q = new URLSearchParams({ next: "/playground" });
    if (need != null && Number.isFinite(need) && need > 0) q.set("need", String(Math.trunc(need)));
    window.location.href = `/insufficient-credits?${q.toString()}`;
  }

  // 创作类型锁定：带入提示词后按其类型锁定可用模型（硬约束，其余类型置灰）
  const [lockedKind, setLockedKind] = useState<ModelKind | null>(null);
  const [lockTitle, setLockTitle] = useState("");

  // 非对话类型的生成参数（模型库未声明时按类型默认）
  const [imgResolution, setImgResolution] = useState("1080");
  const [imgRatio, setImgRatio] = useState("16:9");
  const [imgCount, setImgCount] = useState(1);
  const [vidDuration, setVidDuration] = useState(5);
  const [vidResolution, setVidResolution] = useState("720p");
  const [vidRatio, setVidRatio] = useState("16:9");
  // 视频素材：首帧 / 尾帧 / 参考图 / 参考视频（本站 /uploads/ 地址）
  const [vidFirst, setVidFirst] = useState<string | null>(null);
  const [vidLast, setVidLast] = useState<string | null>(null);
  const [vidRefImages, setVidRefImages] = useState<string[]>([]);
  const [vidRefVideos, setVidRefVideos] = useState<string[]>([]);
  // 有声视频（Ark generate_audio）；首尾帧任务下仍可选
  const [vidAudio, setVidAudio] = useState(true);
  // 记录上一次的视频模型，切换模型时把「有声」恢复为该模型默认值
  const lastVidModel = useRef<string | null>(null);
  // 上传中的素材槽位（first / last / image / video）
  const [vidUploading, setVidUploading] = useState<string | null>(null);
  // 预计消耗：默认「点生成才显示」（提交瞬间给出数字）；
  // ?est=live 恢复实时刷新，?est=off 关闭（保留灰度开关的余地）
  const [estimateMode, setEstimateMode] = useState<"click" | "live" | "off">("click");
  // 点「生成」那一刻锁定的预计消耗（改任何参数即清空）：按「积分/秒 × 秒数」展示
  const [submittedEstimate, setSubmittedEstimate] = useState<{
    perSecond: number;
    seconds: number;
    credits: number;
  } | null>(null);
  const [audVoice, setAudVoice] = useState("女声");
  const [audSpeed, setAudSpeed] = useState(1);
  const [audFormat, setAudFormat] = useState("mp3");

  // 会话
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  // 收藏
  const [favOpen, setFavOpen] = useState(false);
  // 左栏「对话」组：可展开/收起，展开后「新对话」永远置顶 + 历史会话
  const [convOpen, setConvOpen] = useState(true);
  const [favorites, setFavorites] = useState<{ prompts: FavPrompt[]; skills: FavSkill[] }>({
    prompts: [],
    skills: [],
  });
  const [loadedPrompt, setLoadedPrompt] = useState<{
    id: number;
    title: string;
    favorited: boolean;
  } | null>(null);

  // 多段提示词：分段面板（不整段塞进输入框）
  const [segTitle, setSegTitle] = useState("");
  const [segments, setSegments] = useState<PromptSegment[]>([]);
  const [segExpanded, setSegExpanded] = useState(false);
  const [insertedNos, setInsertedNos] = useState<number[]>([]);

  // M3：挂载的技能（服务端按白名单取正文并作为 system 素材注入，不占输入框）
  const [mountedSkill, setMountedSkill] = useState<{
    id: number;
    name: string;
    note: string;
  } | null>(null);
  const [skillBusy, setSkillBusy] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const bootRef = useRef(false);
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const initialUseRef = useRef(initialUse);
  initialUseRef.current = initialUse;
  const appliedUseRef = useRef("");

  // ── 手机端抽屉：与会员中心同一套交互（☰ 翻开 → 主内容右推 75vw 露出左栏；
  //    右拖翻开 / 左拖还原；打开时锁背景滚动；拉宽到 PC 自动还原） ──
  const [drawerOpen, setDrawerOpen] = useState(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!drawerOpen) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [drawerOpen]);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => {
      if (mq.matches) setDrawerOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const onNavTouchStart = (e: React.TouchEvent) => {
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onNavTouchEnd = (e: React.TouchEvent) => {
    const s = touchStartRef.current;
    touchStartRef.current = null;
    if (!s) return;
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    if (dx > 0 && !drawerOpen) setDrawerOpen(true);
    else if (dx < 0 && drawerOpen) setDrawerOpen(false);
  };

  async function refreshSessions(): Promise<SessionItem[]> {
    const data = await apiGet<{ sessions: SessionItem[] }>("/api/playground/sessions");
    if (!data) return [];
    setSessions(data.sessions);
    return data.sessions;
  }

  // 会话消息 → 界面消息：带上媒体产物的 URL 和任务状态，刷新/切页/重新登录都能还原
  function mapSessionMessages(list: SessionMessage[]): Msg[] {
    return list.map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
      images: m.media?.urls?.length ? m.media.urls : undefined,
      taskId: m.taskId ?? undefined,
      task: m.media
        ? { status: m.media.status, progress: m.media.progress, stage: m.media.stage }
        : undefined,
    }));
  }

  // 未结束的媒体任务：重新挂上轮询，切页回来继续更新进度
  function resumeActiveTasks(list: SessionMessage[]) {
    for (const m of list) {
      if (m.taskId && m.media && !["succeeded", "failed"].includes(m.media.status)) {
        void pollTask(m.taskId);
      }
    }
  }

  async function loadSession(id: number) {
    if (busy) return;
    setLoadingSession(true);
    setError(null);
    clearMaterial();
    const data = await apiGet<{
      session: SessionItem;
      messages: SessionMessage[];
    }>(`/api/playground/sessions/${id}`);
    setLoadingSession(false);
    if (!data) return;
    setSessionId(id);
    setMessages(mapSessionMessages(data.messages));
    resumeActiveTasks(data.messages);
    if (modelsRef.current.some((m) => m.name === data.session.modelName)) {
      setModel(data.session.modelName);
    }
    setDrawerOpen(false);
  }

  // 首屏：拉会话列表 + 收藏，并自动打开最近一条会话
  useEffect(() => {
    if (!loggedIn || bootRef.current) return;
    bootRef.current = true;
    let cancelled = false;
    (async () => {
      const [list, fav] = await Promise.all([
        apiGet<{ sessions: SessionItem[] }>("/api/playground/sessions"),
        apiGet<{ prompts: FavPrompt[]; skills: FavSkill[] }>("/api/playground/favorites"),
      ]);
      if (cancelled) return;
      if (list) setSessions(list.sessions);
      if (fav) setFavorites({ prompts: fav.prompts, skills: fav.skills });
      let openedTaskIds = new Set<string>();
      if (list && list.sessions.length > 0 && !initialUseRef.current) {
        const newest = list.sessions[0];
        const detail = await apiGet<{
          session: SessionItem;
          messages: SessionMessage[];
        }>(`/api/playground/sessions/${newest.id}`);
        if (cancelled || !detail) return;
        setSessionId(newest.id);
        setMessages(mapSessionMessages(detail.messages));
        resumeActiveTasks(detail.messages);
        openedTaskIds = new Set(
          detail.messages.map((m) => m.taskId).filter((v): v is string => !!v)
        );
        if (modelsRef.current.some((m) => m.name === detail.session.modelName)) {
          setModel(detail.session.modelName);
        }
      }

      // 刷新恢复：未被会话覆盖的未完成媒体任务重新挂回消息列表并继续轮询
      const active = await apiGet<{ tasks: MediaTaskView[] }>("/api/playground/tasks?active=1");
      const pending = (active?.tasks ?? []).filter((t) => !openedTaskIds.has(t.taskId));
      if (cancelled || !pending.length) return;
      setMessages((prev) => [
        ...prev,
        ...pending.flatMap((t) => [
          { role: "user" as const, content: t.prompt || "（媒体生成任务）" },
          {
            role: "assistant" as const,
            content: taskText(t, taskCopy),
            taskId: t.taskId,
            task: { status: t.status, progress: t.progress, stage: t.stage },
          },
        ]),
      ]);
      for (const t of pending) void pollTask(t.taskId);
    })();
    return () => {
      cancelled = true;
    };
  }, [loggedIn]);

  // 推荐卡片「在实验场试用」带来的内容：只带入一次，避免每次重渲染覆盖用户输入
  useEffect(() => {
    if (!initialUse) return;
    const key = `${initialUse.kind}-${initialUse.id}`;
    if (appliedUseRef.current === key) return;
    appliedUseRef.current = key;
    applyMaterial({
      kind: initialUse.kind,
      id: initialUse.id,
      title: initialUse.title,
      content: initialUse.content,
      promptType: initialUse.promptType,
    });
  }, [initialUse]);

  // 收藏列表刷新后校正「已带入」胶囊上的收藏状态；
  // 依赖 loadedPrompt.id：带入新提示词时立即按最新收藏列表校正（值不变则返回原对象，不会死循环）
  useEffect(() => {
    setLoadedPrompt((p) => {
      if (!p) return p;
      const isFav = favorites.prompts.some((item) => item.id === p.id);
      return isFav === p.favorited ? p : { ...p, favorited: isFav };
    });
  }, [favorites.prompts, loadedPrompt?.id]);

  // 新消息自动滚到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const currentModel = models.find((m) => m.name === model) || models[0];
  const activeKind: ModelKind = lockedKind ?? currentModel?.kind ?? "chat";

  // 图片档位门禁：模型未验证的档位在 select 里 disabled，切换模型后把越界选择拨回可用档
  const imgSpec = currentModel?.imageSpec ?? null;
  useEffect(() => {
    if (!imgSpec) return;
    if (!imgSpec.resolutions.includes(imgResolution)) setImgResolution(imgSpec.resolutions[0] ?? "1080");
    if (!imgSpec.ratios.includes(imgRatio)) setImgRatio(imgSpec.ratios[0] ?? "16:9");
  }, [imgSpec, imgResolution, imgRatio]);

  // 视频能力：直接使用服务端按模型库 advancedConfig 解析好的能力，不在前端写死矩阵
  const vidCap = activeKind === "video" ? (currentModel?.videoCap ?? null) : null;
  // 参考素材上限：后台只能下调，取「模型能力」与「运营上限」的较小值
  const refImageCap = vidCap
    ? referenceLimits.maxReferenceImages == null
      ? vidCap.maxReferenceImages
      : Math.min(vidCap.maxReferenceImages, referenceLimits.maxReferenceImages)
    : 0;
  const refVideoCap = vidCap
    ? referenceLimits.maxReferenceVideos == null
      ? vidCap.maxReferenceVideos
      : Math.min(vidCap.maxReferenceVideos, referenceLimits.maxReferenceVideos)
    : 0;
  // 后台可配格式 → input accept；为空表示该类上传被关闭
  const imageAccept = uploadLimits.imageFormats
    .map((k) => IMAGE_ACCEPT_BY_KIND[k])
    .filter(Boolean)
    .join(",");
  const videoAccept = uploadLimits.videoFormats
    .map((k) => VIDEO_ACCEPT_BY_KIND[k])
    .filter(Boolean)
    .join(",");
  const vidHasFrame = !!(vidFirst || vidLast);
  // 每秒单价（积分/秒）：以后台填写的统一秒价为准，不再按分辨率/含视频输入分档
  const vidPerSecond = vidCap ? (currentModel?.videoPricePerSecond ?? null) : null;
  const vidEstimate =
    vidPerSecond != null ? vidPerSecond * Math.max(1, Math.round(vidDuration)) : null;

  // 切换模型后把越界选择拨回该模型支持的档位（一切以模型库声明为准）
  useEffect(() => {
    if (!vidCap) return;
    if (!vidCap.resolutions.includes(vidResolution)) {
      const preferred =
        vidCap.resolutions.find((r) => ["768p", "720p", "1080p"].includes(r)) ??
        vidCap.resolutions[0] ??
        "720p";
      setVidResolution(preferred);
    }
    if (!vidCap.ratios.includes(vidRatio)) setVidRatio(vidCap.ratios[0] ?? "16:9");
    if (vidDuration < vidCap.minDuration || vidDuration > vidCap.maxDuration) {
      setVidDuration(vidCap.minDuration);
    }
    // 切换模型时恢复该模型默认值：有声模型默认选「有声」
    if (lastVidModel.current !== (currentModel?.name ?? null)) {
      lastVidModel.current = currentModel?.name ?? null;
      setVidAudio(vidCap.audio);
    }
    if (refImageCap === 0) setVidRefImages([]);
    else setVidRefImages((prev) => prev.slice(0, refImageCap));
    if (refVideoCap === 0) setVidRefVideos([]);
    else setVidRefVideos((prev) => prev.slice(0, refVideoCap));
    if (!vidCap.firstFrame) setVidFirst(null);
    if (!vidCap.lastFrame) setVidLast(null);
  }, [vidCap, currentModel?.name, vidResolution, vidRatio, vidDuration, refImageCap, refVideoCap]);

  // 后台「锁定为默认」：锁定后把参数拨回默认值，界面同时置灰，服务端再做一次强制覆盖
  useEffect(() => {
    if (!lockDefaults) return;
    setImgResolution("1080");
    setImgRatio("16:9");
    setImgCount(1);
    setVidResolution("720p");
    setVidRatio(vidHasFrame ? "adaptive" : "16:9");
    setVidDuration(5);
    setVidAudio(!!vidCap?.audio);
  }, [lockDefaults, vidHasFrame, vidCap]);

  // 选中模型后的固定提示位：只在这里展示模型相关的提示文字（下拉选项只留展示名）
  const modelHint = (() => {
    if (!currentModel) return "未选择模型";
    if (lockedKind) {
      return `创作类型已按提示词「${lockTitle}」锁定为${KIND_LABEL[lockedKind]}，其他类型模型已置灰`;
    }
    if (!currentModel.ready) return "该模型端点或定价未配置，生成通道未就绪";
    const minBal = currentModel.minBalanceCredits ?? 0;
    if (minBal > 0 && balanceNow != null && balanceNow < minBal) {
      return `该模型系列要求账户积分不低于 ${minBal}（当前 ${balanceNow}），积分不足会跳转积分不足页`;
    }
    // 旧数据用 remark 存过「视频功能参数见高级配置」，实验场不再展示这条内部提示
    if (currentModel.remark && currentModel.remark !== "视频功能参数见高级配置") {
      return currentModel.remark;
    }
    if (vidCap?.note) return vidCap.note;
    if (imgSpec?.note) return imgSpec.note;
    return "";
  })();

  // 提示气泡：模型变化或有提示时浮出，4.2 秒后自动收起（不占文档流）
  useEffect(() => {
    if (!modelHint) {
      setHintOpen(false);
      return;
    }
    setHintOpen(true);
    const timer = setTimeout(() => setHintOpen(false), 4200);
    return () => clearTimeout(timer);
  }, [modelHint, model]);

  // 首尾帧任务：Ark 要求 ratio 必须是 adaptive（自动跟随首帧画幅）
  useEffect(() => {
    if (vidHasFrame) setVidRatio("adaptive");
  }, [vidHasFrame]);

  // 预计消耗：默认点「生成」才显示；?est=live 实时刷新 / ?est=off 关闭
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("est");
    setEstimateMode(v === "live" ? "live" : v === "off" ? "off" : "click");
  }, []);

  // 任何视频参数/素材变化都清掉上一次的预计消耗，避免展示过期数字
  useEffect(() => {
    setSubmittedEstimate(null);
  }, [vidDuration, vidResolution, vidRatio, vidAudio, vidFirst, vidLast, vidRefImages, vidRefVideos]);

  // 按类型组装参数：以模型库声明为准；模型未声明时用类型默认项（UI 会标注）
  function buildParams(kind: ModelKind): Record<string, string | number> {
    if (kind === "image") {
      return { resolution: imgResolution, aspect_ratio: imgRatio, n: imgCount };
    }
    if (kind === "video") {
      // 视频参数按 Ark 口径：顶层 ratio / duration / resolution / generate_audio
      // 模型库声明了「有声/无声」才传 generate_audio；minimax-h3 系列没有这个参数
      return {
        duration: vidDuration,
        resolution: vidResolution,
        ratio: vidHasFrame ? "adaptive" : vidRatio,
        ...(vidCap?.audioToggle ? { generate_audio: vidAudio ? 1 : 0 } : {}),
      };
    }
    if (kind === "audio") {
      return { voice: audVoice, speed: audSpeed, format: audFormat };
    }
    return { temperature, max_tokens: maxTokens };
  }

  // 视频素材上传：图片/视频统一走 /api/upload，只保存本站 /uploads/ 地址
  async function uploadVideoAsset(file: File, slot: "first" | "last" | "image" | "video") {
    // 游客不允许上传素材（文件会持久化，必须绑定会员账号）
    if (!loggedIn) {
      goAuth();
      return;
    }
    if (lockDefaults && slot !== "first") {
      setError("后台已锁定默认参数，参考素材上传已关闭");
      return;
    }
    // 上传前余额预检：积分不足直接跳积分不足页，不先落盘（否则首帧/参考素材会变成孤儿文件）
    if (loggedIn) {
      let bal = balanceNow;
      try {
        const r = await fetch("/api/playground/balance");
        if (r.ok) {
          const d = (await r.json().catch(() => ({}))) as { balance?: number };
          if (typeof d.balance === "number") {
            bal = d.balance;
            setBalanceNow(d.balance);
          }
        }
      } catch {
        // 余额接口异常时退回服务端下发的快照
      }
      const required = Math.max(currentModel?.minBalanceCredits ?? 0, vidEstimate ?? 0, 1);
      if (bal != null && bal < required) {
        goInsufficient(required);
        return;
      }
    }
    const wantVideo = slot === "video";
    if (wantVideo ? !file.type.startsWith("video/") : !file.type.startsWith("image/")) {
      setError(wantVideo ? "参考视频只支持 mp4 / webm / mov" : "素材必须是图片文件（jpg / png / webp / gif）");
      return;
    }
    // pa25：格式与体积按后台配置先拦一次，避免上传完才被服务端拒绝
    const allowedKinds = wantVideo ? uploadLimits.videoFormats : uploadLimits.imageFormats;
    if (allowedKinds.length === 0) {
      setError(wantVideo ? "后台已关闭视频素材上传" : "后台已关闭图片素材上传");
      return;
    }
    const maxMB = wantVideo ? uploadLimits.videoMaxMB : uploadLimits.imageMaxMB;
    if (file.size > maxMB * 1024 * 1024) {
      setError(
        `${wantVideo ? "视频" : "图片"}不能超过 ${maxMB}MB（当前 ${(file.size / (1024 * 1024)).toFixed(1)}MB）`
      );
      return;
    }
    if (vidCap) {
      if (slot === "image" && vidRefImages.length >= refImageCap) {
        setError(`该模型最多上传 ${refImageCap} 张参考图`);
        return;
      }
      if (slot === "video" && vidRefVideos.length >= refVideoCap) {
        setError(`该模型最多上传 ${refVideoCap} 个参考视频`);
        return;
      }
    }
    // 选中即校验（与服务端同一口径）：图片宽高 ≥300px、参考视频 ≤30s；读不到元信息单独报错
    if (wantVideo) {
      const seconds = await probeVideoDuration(file);
      if (seconds == null) {
        setError("无法读取视频时长，请转成标准 MP4 后再上传");
        return;
      }
      if (seconds > MAX_REFERENCE_VIDEO_SECONDS) {
        setError(`参考视频时长不能超过 ${MAX_REFERENCE_VIDEO_SECONDS} 秒（当前 ${seconds.toFixed(1)} 秒）`);
        return;
      }
    } else {
      const dims = await probeImageSize(file);
      if (!dims) {
        setError("无法读取图片尺寸，请重新导出为 JPG / PNG 后再上传");
        return;
      }
      if (dims.width < MIN_IMAGE_SIDE || dims.height < MIN_IMAGE_SIDE) {
        setError(`图片宽高都不能小于 ${MIN_IMAGE_SIDE}px（当前 ${dims.width}×${dims.height}）`);
        return;
      }
    }
    setVidUploading(slot);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      // scope 让 /api/upload 在落盘前做积分拦截（不写孤儿文件）
      fd.append("scope", "playground");
      if (currentModel?.name) fd.append("model", currentModel.name);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        type?: string;
        error?: string;
        code?: string;
        required?: number;
      };
      if (res.status === 402 && data.code === "insufficient_credits") {
        goInsufficient(data.required);
        return;
      }
      if (!res.ok || !data.url) {
        setError(data.error || `素材上传失败（${res.status}）`);
        return;
      }
      if (slot === "first") setVidFirst(data.url);
      else if (slot === "last") setVidLast(data.url);
      else if (slot === "image") setVidRefImages((prev) => [...prev, data.url!]);
      else setVidRefVideos((prev) => [...prev, data.url!]);
    } catch {
      setError("素材上传失败，请重试");
    } finally {
      setVidUploading(null);
    }
  }

  async function pollTask(taskId: string): Promise<MediaTaskView | null> {
    const deadline = Date.now() + 25 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const res = await fetch(`/api/playground/tasks/${taskId}`).catch(() => null);
      if (!res || !res.ok) return null;
      const data = (await res.json().catch(() => ({}))) as { task?: MediaTaskView };
      const t = data.task;
      if (!t) return null;
      setMessages((prev) =>
        prev.map((m) =>
          m.taskId === taskId
            ? {
                ...m,
                content: taskText(t, taskCopy),
                images: t.status === "succeeded" ? t.urls : undefined,
                task: { status: t.status, progress: t.progress, stage: t.stage },
              }
            : m
        )
      );
      if (t.status === "succeeded" || t.status === "failed") return t;
    }
    return null;
  }

  async function sendMedia(content: string) {
    if (blockGuest()) return;
    if (!currentModel) return;
    const kind = currentModel.kind;
    if (kind !== "image" && kind !== "video") {
      setError("该类型暂未接入生成通道（当前只接通图片 / 视频）");
      return;
    }
    const params = buildParams(kind);
    // 图生视频：首帧必填，前端先拦一次（服务端同样会 400，禁止静默降级成文生视频）
    if (kind === "video" && vidCap?.firstFrame && !vidFirst) {
      setError("该模型是图生视频，请先上传首帧图");
      return;
    }
    // 提交瞬间锁定预计消耗：默认只在点「生成」时展示一次
    if (kind === "video") {
      setSubmittedEstimate(
        vidPerSecond != null
          ? {
              perSecond: vidPerSecond,
              seconds: vidDuration,
              credits: vidPerSecond * vidDuration,
            }
          : null
      );
    }
    // 参考素材（首尾帧 / 参考图 / 参考视频）随任务一起提交
    const attachments =
      kind === "video"
        ? [
            ...(vidFirst ? [{ role: "first_frame", url: vidFirst }] : []),
            ...(vidLast ? [{ role: "last_frame", url: vidLast }] : []),
            ...vidRefImages.map((url) => ({ role: "reference_image", url })),
            ...vidRefVideos.map((url) => ({ role: "reference_video", url })),
          ]
        : [];
    setMessages((prev) => [
      ...prev,
      { role: "user", content },
      { role: "assistant", content: "正在提交任务…" },
    ]);
    setInput("");
    setError(null);
    setErrorGuide(null);
    setBusy(true);
    try {
      // 只提交任务，不等生成：HTTP 请求秒回 taskId，后台 worker 执行，前端轮询进度
      const res = await fetch("/api/playground/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          kind,
          prompt: content,
          params,
          ...(sessionId ? { sessionId } : {}),
          ...(attachments.length ? { attachments } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        rechargeUrl?: string;
        requiredCredits?: number;
        task?: MediaTaskView;
        sessionId?: number;
        guestRemaining?: number;
      };
      if (!res.ok || !data.task) {
        // 游客未登录 / 试玩次数用尽：直接跳登录页，登录后回到实验场
        if (data.code === "guest_trial_exhausted" || data.code === "not_authenticated") {
          setGuestRemaining(0);
          goAuth();
          setMessages((prev) => prev.slice(0, -2));
          setError(null);
          return;
        }
        // 任何积分不足（含系列准入门槛）统一跳积分不足页，不在对话里弹小字
        if (data.code === "min_balance_required" || data.code === "insufficient_credits") {
          goInsufficient(data.requiredCredits ?? vidEstimate);
          return;
        }
        const msg = data.error || `提交失败（${res.status}）`;
        setError(msg);
        setErrorGuide(explainApiError({ code: data.code, status: res.status, message: data.error }));
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === "assistant") copy[copy.length - 1] = { ...last, content: msg };
          return copy;
        });
        return;
      }
      if (typeof data.guestRemaining === "number") setGuestRemaining(data.guestRemaining);
      // 服务端已把本轮写入会话：记住 sessionId，切页回来/刷新/重新登录都能读回
      if (typeof data.sessionId === "number") {
        setSessionId(data.sessionId);
        void refreshSessions();
      }
      const taskId = data.task.taskId;
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.role === "assistant") {
          copy[copy.length - 1] = {
            ...last,
            taskId,
            content: taskText(data.task!, taskCopy),
            task: { status: data.task!.status, progress: data.task!.progress, stage: data.task!.stage },
          };
        }
        return copy;
      });
      const done = await pollTask(taskId);
      if (!done) setError("任务状态查询中断，刷新页面可继续查看进度");
    } catch {
      setError("网络异常，请稍后重试");
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setBusy(false);
    }
  }

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || busy || skillBusy || !model) return;
    // 游客：未开启试玩 / 次数用尽 → 弹登录注册引导（页面仍可浏览）
    if (blockGuest()) return;
    if (maintenance?.enabled) {
      setError(maintenance.message);
      return;
    }
    // 锁定类型但模型库没有该类型可用模型时，明确告知而不是偷偷用别的模型
    if (lockedKind && currentModel && currentModel.kind !== lockedKind) {
      setError(`当前已锁定「${KIND_LABEL[lockedKind]}」，但模型库里没有可用的该类模型`);
      return;
    }
    // 非文本创作：参数随请求提交到 playground 生成接口
    if (currentModel && currentModel.kind !== "chat") {
      await sendMedia(content);
      return;
    }
    const history = [...messages, { role: "user" as const, content }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setError(null);
    setErrorGuide(null);
    setBusy(true);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/playground/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: history,
          temperature,
          max_tokens: maxTokens,
          ...(sessionId ? { sessionId } : {}),
          // M3：技能只传 id，正文由服务端按白名单取用并清洗
          ...(mountedSkill ? { skillIds: [mountedSkill.id] } : {}),
        }),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
          requiredCredits?: number;
        };
        if (data.code === "guest_trial_exhausted" || data.code === "not_authenticated") {
          setGuestRemaining(0);
          goAuth();
          setMessages(history);
          // 去掉空的占位回复，回到发送前的状态
          return;
        }
        if (data.code === "min_balance_required" || data.code === "insufficient_credits") {
          goInsufficient(data.requiredCredits);
          return;
        }
        setError(data.error || "请求失败，请稍后重试");
        setErrorGuide(explainApiError({ code: data.code, status: res.status, message: data.error }));
        // 去掉空的占位回复，回到发送前的状态
        setMessages(history);
        return;
      }

      // 新会话：服务端在响应头回传会话 id（游客无会话）
      const sid = Number(res.headers.get("X-Playground-Session-Id") || 0);
      if (sid > 0) setSessionId(sid);
      const gr = res.headers.get("X-Playground-Guest-Remaining");
      if (gr != null && gr !== "") setGuestRemaining(Number(gr));

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload) as {
              choices?: { delta?: { content?: string } }[];
            };
            const piece = j.choices?.[0]?.delta?.content;
            if (typeof piece === "string" && piece) {
              setMessages((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last && last.role === "assistant") {
                  copy[copy.length - 1] = { ...last, content: last.content + piece };
                }
                return copy;
              });
            }
          } catch {
            /* 忽略心跳/非 JSON 行 */
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        // 主动停止：保留已生成内容；若一个字都没出，去掉空气泡
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last && last.role === "assistant" && !last.content) copy.pop();
          return copy;
        });
      } else {
        setError("网络异常，请稍后重试");
        setMessages(history);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      // 刷新侧栏（新会话出现 / 标题与时间更新）；游客无历史会话
      if (loggedIn) void refreshSessions();
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function newChat() {
    if (busy) return;
    // 游客点「新对话」直接去登录，不弹提示层
    if (blockGuest()) return;
    setSessionId(null);
    setMessages([]);
    setError(null);
    clearMaterial();
  }

  // 左栏入口：切换到指定创作类型。
  // 优先用后台设定的默认图片/视频模型，其次取该类型第一个模型；没有模型时给出提示。
  function pickKind(kind: ModelKind) {
    if (blockGuest()) return;
    // 已是当前类型时不重置模型，只回到工作台（避免把用户手选的模型换掉）
    if (activeKind === kind) {
      setDrawerOpen(false);
      document.getElementById("pg-workbench")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const wanted =
      kind === "image" ? defaultModels.image : kind === "video" ? defaultModels.video : "";
    const first =
      (wanted ? models.find((m) => m.kind === kind && m.name === wanted) : undefined) ??
      models.find((m) => m.kind === kind);
    if (!first) {
      setError(`暂无${KIND_LABEL[kind]}模型，请稍后再试`);
      return;
    }
    setModel(first.name);
    setError(null);
    // 主动切换类型时解除「提示词带入」的类型锁定，避免选了别的类型却被置灰
    setLockedKind(null);
    setLockTitle("");
    setShowParams(false);
    setDrawerOpen(false);
    if (typeof window !== "undefined") {
      document.getElementById("pg-workbench")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  async function deleteSession(id: number) {
    if (busy) return;
    const res = await fetch(`/api/playground/sessions/${id}`, { method: "DELETE" });
    if (!res.ok) return;
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (sessionId === id) {
      setSessionId(null);
      setMessages([]);
      setError(null);
    }
  }

  async function saveTitle(id: number) {
    const title = editingTitle.trim();
    setEditingId(null);
    if (!title) return;
    const res = await fetch(`/api/playground/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (res.ok) {
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
    }
  }

  function useFavorite(item: { title: string; content: string; type?: string }, promptId?: number, skillId?: number) {
    if (skillId) {
      void mountSkill(skillId, item.title);
      setFavOpen(false);
      return;
    }
    applyMaterial({
      kind: promptId ? "prompt" : "skill",
      id: promptId,
      title: item.title,
      content: item.content,
      promptType: item.type,
    });
    setFavOpen(false);
  }

  // M3：技能不走「正文塞输入框」，改为服务端准备素材 + 发送时按 skillId 注入
  async function mountSkill(id: number, title: string) {
    if (blockGuest()) return;
    setSkillBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/playground/skills/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: id }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        skill?: { name?: string; summary?: string | null };
        report?: { masked?: number; neutralized?: number; injectionHits?: string[] };
      };
      if (!res.ok) {
        setError(data.error || "该技能暂时无法在实验场运行");
        return;
      }
      const notes: string[] = [];
      if (data.report?.injectionHits?.length) {
        notes.push(`素材含 ${data.report.injectionHits.length} 处疑似指令，已按原文隔离`);
      }
      if (data.report?.masked) notes.push(`已脱敏 ${data.report.masked} 处隐私信息`);
      const name = data.skill?.name || title;
      const summary = (data.skill?.summary || "").trim();
      setMountedSkill({
        id,
        name,
        note: notes.join("；"),
      });
      // 技能即插即用：锁定文本创作、选后台默认聊天模型、清空视频素材与参数面板
      setLockedKind("chat");
      setLockTitle(name);
      const dm = defaultModels as { image: string; video: string; chat?: string };
      const chatModel =
        (dm.chat
          ? modelsRef.current.find((m) => m.kind === "chat" && m.name === dm.chat)
          : undefined) ?? modelsRef.current.find((m) => m.kind === "chat");
      if (chatModel) setModel(chatModel.name);
      setVidFirst(null);
      setVidLast(null);
      setVidRefImages([]);
      setVidRefVideos([]);
      setShowParams(false);
      // 输入框为空时预填一句可直接发送的话；已有内容不覆盖
      const greet = summary
        ? `请使用「${name}」技能，按技能说明完成：${summary}`
        : `请使用「${name}」技能，按技能说明开始执行。`;
      setInput((prev) => (prev.trim() ? prev : greet));
      setSegTitle("");
      setSegments([]);
      setInsertedNos([]);
      setSegExpanded(false);
      setLoadedPrompt(null);
    } catch {
      setError("技能加载失败，请稍后重试");
    } finally {
      setSkillBusy(false);
    }
  }

  // 带入素材：整段写进输入框（多段按【第 N 段】拼接），技能走服务端挂载；绝不自动发送
  function applyMaterial(opts: {
    kind: "prompt" | "skill";
    id?: number;
    title: string;
    content: string;
    promptType?: string;
  }) {
    if (opts.kind === "skill" && opts.id) {
      void mountSkill(opts.id, opts.title);
      return;
    }
    const segs = parseSegments(opts.content);
    setInsertedNos([]);
    setSegExpanded(false);
    setSegTitle("");
    setSegments([]);
    // 多段提示词也直接拼进输入框，不再打开分段面板；点击带入即代表要覆盖输入框使用
    setInput(
      segs.length >= 2
        ? segs.map((s) => `【第 ${s.no} 段】\n${s.text}`).join("\n\n")
        : opts.content
    );
    setLoadedPrompt(
      opts.kind === "prompt" && opts.id
        ? {
            id: opts.id,
            title: opts.title,
            // 收藏状态按当前收藏列表回填，避免把已收藏提示词显示成未收藏后被点掉
            favorited: favorites.prompts.some((x) => x.id === opts.id),
          }
        : null
    );

    // 创作类型锁定：提示词类型决定可用模型，并自动切到该类型第一个模型
    if (opts.kind === "prompt") {
      const kind = kindOfPromptType(opts.promptType);
      setLockedKind(kind);
      setLockTitle(opts.title);
      if (kind !== "chat") setShowParams(true);
      const wanted =
        kind === "image" ? defaultModels.image : kind === "video" ? defaultModels.video : "";
      const first =
        (wanted
          ? modelsRef.current.find((m) => m.kind === kind && m.name === wanted)
          : undefined) ?? modelsRef.current.find((m) => m.kind === kind);
      if (first) setModel(first.name);
    } else {
      setLockedKind(null);
      setLockTitle("");
    }
  }

  // 逐段插入：每段前带【第 N 段】标记，和手写内容区分开
  function insertSegment(seg: PromptSegment) {
    setInput((prev) => {
      const block = `【第 ${seg.no} 段】\n${seg.text}`;
      const base = prev.replace(/\s+$/, "");
      return base ? `${base}\n\n${block}\n\n` : `${block}\n\n`;
    });
    setInsertedNos((prev) => (prev.includes(seg.no) ? prev : [...prev, seg.no]));
  }

  function clearMaterial() {
    setSegTitle("");
    setSegments([]);
    setInsertedNos([]);
    setSegExpanded(false);
    setLoadedPrompt(null);
    setLockedKind(null);
    setLockTitle("");
    setMountedSkill(null);
  }

  async function refreshFavorites() {
    const fav = await apiGet<{ prompts: FavPrompt[]; skills: FavSkill[] }>(
      "/api/playground/favorites"
    );
    if (fav) setFavorites({ prompts: fav.prompts, skills: fav.skills });
  }

  async function toggleFavorite() {
    if (!loadedPrompt) return;
    // 收藏属于账号能力：游客点击直接去登录
    if (blockGuest()) return;
    const res = await fetch("/api/user/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", targetId: loadedPrompt.id }),
    });
    if (!res.ok) return;
    const data = (await res.json().catch(() => ({}))) as { favorited?: boolean };
    setLoadedPrompt((p) => (p ? { ...p, favorited: !!data.favorited } : p));
    void refreshFavorites();
  }

  if (models.length === 0) {
    return (
      <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-6 py-14 text-center">
        <p className="text-base font-semibold text-zinc-100">暂无可用模型</p>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-zinc-500">
          站长还没有在后台把对话模型设为「已上线」或配置价格，稍后再来看看。
        </p>
      </div>
    );
  }

  // 左栏条目的统一状态样式：12px，选中态有天蓝/翠绿描边，未选中低对比但可读
  const navItemClass = (active: boolean) =>
    `flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-xs transition ${
      active
        ? "bg-emerald-500/10 text-emerald-200 ring-1 ring-emerald-500/30"
        : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
    }`;

  const sidebarBody = (
    <>
        {/* 左栏顶部品牌（沿用站点实验场标识） */}
        <div className="mb-1 flex items-center gap-2 px-1">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-emerald-400/25 bg-emerald-500/10 text-emerald-300">
            <PlaygroundMark className="h-4 w-4" />
          </span>
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-xs font-semibold text-zinc-100">冰山实验场</span>
            <span className="block truncate text-xs text-zinc-500">AI Playground</span>
          </span>
        </div>

        {/* 第一组：对话（可展开/收起）+ 三种站内生成能力 */}
        <nav className="mt-2 space-y-1" aria-label="创作入口">
          <div>
            <button
              type="button"
              onClick={() => setConvOpen((v) => !v)}
              aria-expanded={convOpen}
              className={navItemClass(activeKind === "chat")}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 5h16v10H9l-5 4V5z" />
              </svg>
              <span className="flex-1 text-left">对话</span>
              <span className={`text-xs text-zinc-500 transition-transform ${convOpen ? "rotate-180" : ""}`}>⌄</span>
            </button>

            {convOpen && (
              <div className="mt-1 space-y-1 border-l border-zinc-800 pl-2">
                <button
                  type="button"
                  onClick={() => {
                    newChat();
                    setDrawerOpen(false);
                  }}
                  disabled={busy}
                  className="w-full rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 px-2.5 py-1.5 text-xs font-semibold text-white shadow-lg shadow-emerald-600/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  ＋ 新对话
                </button>

        <p className="px-1 pt-1 text-xs text-zinc-500">历史对话</p>
        <div className="max-h-[200px] space-y-1 overflow-y-auto pr-0.5 lg:max-h-[340px]">
          {sessions.length === 0 ? (
            <p className="px-1 py-2 text-xs text-zinc-500">还没有历史对话</p>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className={`group flex items-center gap-1 rounded-xl px-2 py-1.5 text-xs transition ${
                  sessionId === s.id
                    ? "bg-emerald-500/10 text-emerald-200 ring-1 ring-emerald-500/30"
                    : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                }`}
              >
                {editingId === s.id ? (
                  <input
                    autoFocus
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveTitle(s.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    onBlur={() => void saveTitle(s.id)}
                    className="min-w-0 flex-1 rounded border border-emerald-500/50 bg-zinc-950 px-1.5 py-1 text-xs text-zinc-100 outline-none"
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void loadSession(s.id)}
                      disabled={busy}
                      title={s.title}
                      className="min-w-0 flex-1 truncate text-left disabled:cursor-not-allowed"
                    >
                      {s.title}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(s.id);
                        setEditingTitle(s.title);
                      }}
                      aria-label="重命名"
                      className="shrink-0 rounded p-0.5 text-zinc-500 opacity-0 transition hover:text-emerald-300 group-hover:opacity-100"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteSession(s.id)}
                      aria-label="删除"
                      className="shrink-0 rounded p-0.5 text-zinc-500 opacity-0 transition hover:text-rose-300 group-hover:opacity-100"
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
        {sessions.length > 0 && (
          <p className="px-1 text-xs text-zinc-500">最近：{timeAgo(sessions[0].updatedAt)}</p>
        )}
              </div>
            )}
          </div>

          {(["image", "video", "audio"] as ModelKind[]).map((k) => {
            const label = k === "image" ? "图像生成" : k === "video" ? "视频生成" : "音频生成";
            const count = models.filter((m) => m.kind === k).length;
            return (
              <button
                key={k}
                type="button"
                onClick={() => pickKind(k)}
                className={navItemClass(activeKind === k)}
              >
                {k === "image" ? (
                  <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5" />
                  </svg>
                ) : k === "video" ? (
                  <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M4 6h12v12H4zM16 10l4-2v8l-4-2" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M9 18V6l10-2v12M9 18a3 3 0 1 1-3-3M19 16a3 3 0 1 1-3-3" />
                  </svg>
                )}
                <span className="flex-1 text-left">{label}</span>
                <span className="text-xs text-zinc-500">{count}</span>
              </button>
            );
          })}
        </nav>

        {/* 第二组：我的收藏 / 使用记录 */}
        <div className="mt-2 space-y-1 border-t border-zinc-800 pt-2">
          <button
            type="button"
            onClick={() => {
              const next = !favOpen;
              setFavOpen(next);
              // 展开时重新拉一次收藏，刚收藏的内容立刻可见；失败静默
              if (next) void refreshFavorites();
            }}
            aria-expanded={favOpen}
            className={navItemClass(false)}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 4.5l2.3 4.9 5.2.7-3.8 3.7.9 5.2-4.6-2.5-4.6 2.5.9-5.2L4.5 10l5.2-.7z" />
            </svg>
            <span className="flex-1 text-left">我的收藏</span>
            <span className="text-xs text-zinc-500">
              {favorites.prompts.length + favorites.skills.length} {favOpen ? "▴" : "▾"}
            </span>
          </button>
          {favOpen && (
            <div className="mt-1 max-h-[260px] space-y-2 overflow-y-auto pr-0.5">
              {favorites.prompts.length === 0 && favorites.skills.length === 0 ? (
                <p className="px-1 py-2 text-xs leading-relaxed text-zinc-600">
                  还没有收藏。去提示词或技能详情页点收藏，就会出现在这里。
                </p>
              ) : (
                <>
                  {favorites.prompts.length > 0 && (
                    <div>
                      <p className="px-1 text-xs uppercase tracking-wide text-zinc-600">
                        提示词
                      </p>
                      {favorites.prompts.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => useFavorite(p, p.id)}
                          className="block w-full rounded-lg px-1.5 py-1 text-left transition hover:bg-zinc-800/60"
                        >
                          <span className="block truncate text-xs text-zinc-300">{p.title}</span>
                          {p.category && (
                            <span className="block truncate text-xs text-zinc-600">
                              {p.category}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                  {favorites.skills.length > 0 && (
                    <div>
                      <p className="px-1 text-xs uppercase tracking-wide text-zinc-600">技能</p>
                      {favorites.skills.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => useFavorite({ title: s.name, content: s.content }, undefined, s.id)}
                          className="block w-full rounded-lg px-1.5 py-1 text-left transition hover:bg-zinc-800/60"
                        >
                          <span className="block truncate text-xs text-zinc-300">{s.name}</span>
                          <span className="block truncate text-xs text-zinc-600">技能</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* 使用记录：站内真实入口（会员中心 → 用量明细） */}
          <Link
            href="/member?tab=usage"
            onClick={() => setDrawerOpen(false)}
            className={navItemClass(false)}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 19V5M4 19h16M8 16v-4M12 16V8M16 16v-7" />
            </svg>
            <span className="flex-1 text-left">使用记录</span>
            <span className="text-xs text-zinc-500">›</span>
          </Link>
        </div>

        {/* 底部中性广告位：纯装饰、不可点，后续只换图（替换原「升级会员」卡） */}
        <div
          aria-hidden="true"
          className="mt-3 hidden select-none overflow-hidden rounded-2xl border border-zinc-800/80 bg-gradient-to-br from-zinc-800/40 via-zinc-900/60 to-emerald-500/10 p-3 lg:block"
        >
          <div className="h-16 rounded-xl border border-white/5 bg-[radial-gradient(circle_at_20%_20%,rgba(56,189,248,0.18),transparent_55%),radial-gradient(circle_at_80%_80%,rgba(16,185,129,0.16),transparent_55%)]" />
          <p className="mt-2 text-center text-xs text-zinc-500">广告位</p>
        </div>
    </>
  );

  const activeSession = sessions.find((s) => s.id === sessionId);

  // 分段面板：优先展示还没插入的下一段，"下面还有 N 段"按剩余未插入算
  const insertedSet = new Set(insertedNos);
  const remainingSegs = segments.filter((s) => !insertedSet.has(s.no));
  const nextSeg = remainingSegs[0] ?? null;
  const remainingCount = remainingSegs.length;

  return (
    <div className="mt-6 overflow-x-clip">
      {/* 顶部横幅：纯展示介绍（标题 / 说明 / 氛围视觉），不放任何功能按钮 */}
      <section className="relative mb-4 overflow-hidden rounded-[26px] border border-zinc-800/70 bg-zinc-950">
        {/* 氛围层：双径向渐变 + 网格遮罩 + 光斑，纯装饰 */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 bg-[radial-gradient(120%_130%_at_0%_0%,rgba(16,185,129,0.18),transparent_55%),radial-gradient(110%_120%_at_100%_100%,rgba(56,189,248,0.16),transparent_58%)]" />
          <div className="absolute inset-0 opacity-[0.14] [background-image:linear-gradient(to_right,rgba(255,255,255,0.14)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.14)_1px,transparent_1px)] [background-size:46px_46px] [mask-image:radial-gradient(ellipse_at_50%_40%,black,transparent_78%)]" />
          <div className="absolute -top-32 left-1/3 h-72 w-72 rounded-full bg-emerald-400/15 blur-3xl" />
          <div className="absolute -bottom-40 -left-24 h-80 w-80 rounded-full bg-sky-500/15 blur-3xl" />
        </div>

        <div className="relative grid gap-7 px-5 py-9 sm:gap-8 sm:px-8 sm:py-11 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-center lg:gap-10 lg:px-10 lg:py-12">
          {/* 左：标识 + 标题 + 说明 + 非交互特性 */}
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 shrink-0 overflow-hidden rounded-xl border border-emerald-400/25 bg-zinc-900">
                {avatarUrl ? (
                  avatarIsDefault ? (
                    <div
                      className="h-full w-full"
                      style={{
                        backgroundImage: `url(${avatarUrl})`,
                        backgroundSize: "300%",
                        backgroundPosition: "75% 17%",
                        backgroundRepeat: "no-repeat",
                      }}
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                  )
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-emerald-300">
                    <PlaygroundMark className="h-5 w-5" />
                  </div>
                )}
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                实验场 · Iceberg Playground
              </span>
            </div>

            <h1 className="mt-5 text-[26px] font-black leading-[1.15] tracking-tight text-zinc-50 sm:text-4xl lg:text-[42px]">
              把提示词，
              <br className="hidden sm:block" />
              直接变成作品
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-7 text-zinc-400 sm:text-[15px]">
              同一个工作台里切换文本、图像、视频与音频模型：提示词粘进来就能试跑，
              素材可上传、参数可微调，每一步结果都会自动保存。
            </p>

            <ul className="mt-6 flex flex-wrap gap-2 text-xs text-zinc-400 sm:grid sm:grid-cols-3 sm:gap-3 sm:text-[13px]">
              {[
                { t: "一站多模型", d: "四种能力随时切换" },
                { t: "提示词即试即得", d: "无需跳转单独工具" },
                { t: "结果自动留存", d: "对话与作品可回溯" },
              ].map((f) => (
                <li
                  key={f.t}
                  className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800/60 bg-zinc-900/40 px-3 py-1.5 sm:items-start sm:gap-2 sm:rounded-xl sm:px-3 sm:py-2.5"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="h-3.5 w-3.5 shrink-0 text-emerald-400/90 sm:mt-0.5 sm:h-4 sm:w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  <span className="min-w-0">
                    <span className="block font-semibold text-zinc-200">{f.t}</span>
                    <span className="mt-0.5 hidden text-zinc-500 sm:block">{f.d}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* 右：装饰性输出预览（不可交互、无按钮语义） */}
          <div aria-hidden className="relative mx-auto w-full max-w-[420px] lg:mx-0">
            <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/60 p-3 shadow-[0_28px_70px_-24px_rgba(0,0,0,0.9)] backdrop-blur">
              <div className="flex items-center gap-1.5 px-1 pb-2.5">
                <span className="h-2 w-2 rounded-full bg-rose-400/60" />
                <span className="h-2 w-2 rounded-full bg-amber-400/60" />
                <span className="h-2 w-2 rounded-full bg-emerald-400/60" />
                <span className="ml-2 text-xs text-zinc-500">playground · 输出预览</span>
              </div>
              <div className="space-y-1.5 rounded-xl border border-zinc-800/70 bg-zinc-950/70 p-3">
                <div className="h-1.5 w-4/5 rounded-full bg-zinc-700/70" />
                <div className="h-1.5 w-3/5 rounded-full bg-zinc-800" />
              </div>
              <div className="mt-2.5 grid grid-cols-3 gap-2">
                <div className="aspect-square rounded-lg bg-gradient-to-br from-emerald-500/35 via-teal-500/10 to-transparent ring-1 ring-inset ring-white/5" />
                <div className="aspect-square rounded-lg bg-gradient-to-br from-sky-500/35 via-indigo-500/10 to-transparent ring-1 ring-inset ring-white/5" />
                <div className="aspect-square rounded-lg bg-gradient-to-br from-violet-500/35 via-fuchsia-500/10 to-transparent ring-1 ring-inset ring-white/5" />
              </div>
              <div className="mt-2.5 flex items-center gap-2">
                <div className="h-1.5 flex-1 rounded-full bg-zinc-800" />
                <div className="h-1.5 w-10 rounded-full bg-zinc-800" />
              </div>
            </div>
            <div className="pointer-events-none absolute -right-5 -top-5 h-24 w-24 rounded-full bg-emerald-400/20 blur-2xl" />
          </div>
        </div>
      </section>
      {/* 手机端顶部条：☰ 翻开抽屉（PC 隐藏） */}
      <div className="mb-3 flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 lg:hidden">
        <button
          type="button"
          aria-label="打开展示栏"
          onClick={() => setDrawerOpen(true)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700 text-zinc-300 active:bg-zinc-800"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">
          {activeSession?.title || "新对话"}
        </span>
        <span className="shrink-0 text-xs text-zinc-500">{sessions.length} 条历史</span>
      </div>

      <div className="relative">
        {/* 手机端抽屉：主内容右推 75vw 时从左侧露出（fixed 不随主内容位移） */}
        <aside
          className={`fixed inset-y-0 left-0 z-10 flex w-[75vw] max-w-xs flex-col gap-1 overflow-y-auto border-r border-zinc-800 bg-zinc-950 p-3 shadow-2xl transition-transform duration-300 lg:hidden ${
            drawerOpen ? "translate-x-0" : "-translate-x-full"
          }`}
          style={{
            // 站点头部固定在最上层，抽屉内容从头部下方开始，避免标题被压住
            paddingTop: "calc(env(safe-area-inset-top, 0px) + 64px)",
            paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)",
          }}
          onTouchStart={onNavTouchStart}
          onTouchEnd={onNavTouchEnd}
        >
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-xs font-medium tracking-wide text-zinc-500">创作与记录</span>
            <button
              type="button"
              aria-label="关闭菜单"
              onClick={() => setDrawerOpen(false)}
              className="rounded-lg px-2 py-1 text-zinc-500 transition hover:text-zinc-300"
            >
              ✕
            </button>
          </div>
          {sidebarBody}
        </aside>

        <div id="pg-workbench" className="scroll-mt-24 lg:grid lg:grid-cols-[248px_1fr] lg:gap-4">
          {/* PC 左栏：创作入口 / 对话与历史 / 收藏与使用记录 */}
          <aside className="hidden flex-col gap-1 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-3 lg:flex">
            {sidebarBody}
          </aside>

          {/* 主内容：抽屉打开时整体右推 */}
          <div
            className="relative z-20 transition-transform duration-300 lg:!translate-x-0"
            style={drawerOpen ? { transform: "translateX(75vw)" } : undefined}
            onTouchStart={onNavTouchStart}
            onTouchEnd={onNavTouchEnd}
          >
            <button
              type="button"
              aria-label="关闭菜单"
              onClick={() => setDrawerOpen(false)}
              className={`absolute inset-0 z-50 bg-black/60 lg:hidden ${
                drawerOpen ? "block" : "hidden"
              }`}
            />

      {/* 对话卡片：占满可用高度，消息区自适应，整体风格与站点一致 */}
      <div className="flex min-h-[calc(100dvh-220px)] flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60">
        {/* 模型 / 参数工具栏统一放在下方输入区（不再显示在线/离线状态） */}

        {/* 消息区：第一版观感 —— 居中窄栏、助手正文无边框、用户渐变气泡 */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-6">
          {loadingSession ? (
            <div className="flex h-full items-center justify-center text-xs text-zinc-500">
              正在加载对话…
            </div>
          ) : messages.length === 0 ? (
            <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center text-center">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200">
                <PlaygroundMark className="h-3.5 w-3.5" />
                实验场 · Iceberg Playground
              </span>
              <h2 className="mt-5 text-2xl font-bold tracking-tight text-zinc-100 sm:text-3xl">
                想试什么？直接说就好
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-500">
                选好模型、调好参数，把资料库里的提示词或技能直接拿来跑一遍。
                <br className="hidden sm:block" />
                当前模型：{currentModel?.displayName || "未选择"}
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                {QUICK_STARTS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => send(q)}
                    className="rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-emerald-500/60 hover:text-emerald-300"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-5">
              {messages.map((m, i) => (
                <div key={i} className={`flex gap-3 ${m.role === "user" ? "justify-end" : ""}`}>
                  {m.role === "assistant" && (
                    <div className="mt-0.5 h-8 w-8 shrink-0 overflow-hidden rounded-xl border border-emerald-400/20 bg-zinc-900 text-emerald-200">
                      {avatarUrl ? (
                        avatarIsDefault ? (
                          <div
                            className="h-full w-full"
                            style={{
                              backgroundImage: `url(${avatarUrl})`,
                              backgroundSize: "300%",
                              backgroundPosition: "75% 17%",
                              backgroundRepeat: "no-repeat",
                            }}
                          />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                        )
                      ) : (
                        <div className="flex h-full w-full items-center justify-center">
                          <PlaygroundMark className="h-4 w-4" />
                        </div>
                      )}
                    </div>
                  )}
                  <div className={m.role === "user" ? "max-w-[82%]" : "min-w-0 max-w-[92%] flex-1"}>
                    {m.role === "user" ? (
                      <div className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-gradient-to-br from-emerald-500/30 to-teal-600/30 px-4 py-2.5 text-[0.94rem] leading-7 text-zinc-100">
                        {m.content}
                      </div>
                    ) : m.content || m.images?.length ? (
                      <div
                        className={`rounded-2xl rounded-tl-md border px-3.5 py-2.5 text-[0.94rem] leading-7 ${
                          m.task?.status === "failed"
                            ? "border-rose-500/25 bg-rose-500/5 text-rose-300"
                            : "border-zinc-800 bg-zinc-900/40 text-zinc-200"
                        }`}
                      >
                        {m.content && <RichText text={m.content} />}
                        {m.images && m.images.length > 0 && (
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            {m.images.map((src, k) =>
                              /\.(mp4|webm|mov)(\?|$)/i.test(src) ? (
                                <SiteVideoPlayer key={k} src={src} />
                              ) : (
                                <a
                                  key={k}
                                  href={src}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="block overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60 transition hover:border-emerald-500/50"
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={src}
                                    alt={`生成结果 ${k + 1}`}
                                    loading="lazy"
                                    className="h-full w-full object-cover"
                                  />
                                </a>
                              )
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 py-2">
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-400/70" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-400/70 [animation-delay:120ms]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-400/70 [animation-delay:240ms]" />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 错误提示（不展示任何扣费金额） */}
        {error && (
          <div className="mx-3 mb-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 sm:mx-4">
            {error}
          </div>
        )}
        <ApiErrorDialog guide={errorGuide} onClose={() => setErrorGuide(null)} />

        {/* 输入区：第一版观感 —— 一体化输入容器，底行放提示与发送 */}
        <div className="border-t border-zinc-800 px-3 py-3 sm:px-6">
          <div className="relative mx-auto max-w-3xl">
            {/* 模型提示气泡：浮在输入框上方，几秒后自动消失，不占版面 */}
            {modelHint && hintOpen && !showParams && (
              <div
                role="status"
                className="pointer-events-none absolute bottom-full left-0 z-40 mb-2 max-w-[min(560px,92vw)] rounded-xl border border-emerald-500/25 bg-zinc-900/95 px-3 py-2 text-xs leading-5 text-zinc-200 shadow-2xl backdrop-blur"
              >
                {modelHint}
              </div>
            )}
            {/* 高级参数：绝对定位悬浮层，不占文档流 —— 展开/收起不改变页面高度，页面与消息区滚动位置保持不变 */}
            {showParams && (
              <div className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-[60vh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-950/95 p-3 pt-6 shadow-2xl backdrop-blur sm:grid sm:grid-cols-3 sm:gap-4 sm:px-4">
            <button
              type="button"
              aria-label="关闭参数面板"
              onClick={() => setShowParams(false)}
              className="absolute right-2 top-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
            >
              ✕
            </button>
            {activeKind === "chat" && (
              <>
                <label className="text-xs text-zinc-400">
                  <span className="mb-1 flex items-center justify-between">
                    随机性 temperature
                    <span className="text-zinc-600">{temperature.toFixed(1)}</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={temperature}
                    onChange={(e) => setTemperature(Number(e.target.value))}
                    disabled={busy}
                    className="w-full accent-emerald-500"
                  />
                  <span className="mt-1 block text-xs text-zinc-600">越大越发散，越小越稳定</span>
                </label>
                <label className="text-xs text-zinc-400">
                  <span className="mb-1 flex items-center justify-between">
                    最大回复长度
                    <span className="text-zinc-600">{maxTokens}</span>
                  </span>
                  <input
                    type="range"
                    min={128}
                    max={4096}
                    step={128}
                    value={maxTokens}
                    onChange={(e) => setMaxTokens(Number(e.target.value))}
                    disabled={busy}
                    className="w-full accent-emerald-500"
                  />
                  <span className="mt-1 block text-xs text-zinc-600">限制单次回复长度</span>
                </label>
              </>
            )}

            {activeKind === "image" && (
              <>
                <label className="text-xs text-zinc-400">
                  <span className="mb-1 block">分辨率</span>
                  <select
                    value={imgResolution}
                    onChange={(e) => setImgResolution(e.target.value)}
                    disabled={lockDefaults || busy}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-2 py-1.5 text-xs text-zinc-300 outline-none focus:border-emerald-500 disabled:opacity-50"
                  >
                    <option value="1080">1080（约 1080p）</option>
                    <option value="2K" disabled={!!imgSpec && !imgSpec.resolutions.includes("2K")}>
                      2K{!!imgSpec && !imgSpec.resolutions.includes("2K") ? " · 该模型未验证" : ""}
                    </option>
                    <option value="4K" disabled={!!imgSpec && !imgSpec.resolutions.includes("4K")}>
                      4K{!!imgSpec && !imgSpec.resolutions.includes("4K") ? " · 该模型未验证" : ""}
                    </option>
                  </select>
                </label>
                <label className="text-xs text-zinc-400">
                  <span className="mb-1 block">画面比例</span>
                  <select
                    value={imgRatio}
                    onChange={(e) => setImgRatio(e.target.value)}
                    disabled={lockDefaults || busy}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-2 py-1.5 text-xs text-zinc-300 outline-none focus:border-emerald-500 disabled:opacity-50"
                  >
                    <option value="16:9">16:9 横图</option>
                    <option value="9:16">9:16 竖屏</option>
                    <option value="4:3">4:3</option>
                    <option value="3:4">3:4 竖版</option>
                    <option value="1:1">1:1 方形</option>
                  </select>
                  <span className="mt-1 block text-xs text-zinc-600">
                    实际出图 {imageSize(imgResolution as ImageResolution, imgRatio as ImageRatio)}
                  </span>
                </label>
                <label className="text-xs text-zinc-400">
                  <span className="mb-1 flex items-center justify-between">
                    生成张数
                    <span className="text-zinc-600">{imgCount}</span>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={4}
                    step={1}
                    value={imgCount}
                    onChange={(e) => setImgCount(Number(e.target.value))}
                    disabled={lockDefaults || busy}
                    className="w-full accent-emerald-500"
                  />
                </label>
                {lockDefaults && (
                  <p className="text-xs leading-5 text-amber-300/80 sm:col-span-3">
                    后台已锁定默认参数：分辨率 / 比例 / 张数固定为 1080 · 16:9 · 1 张。
                  </p>
                )}
              </>
            )}

            {activeKind === "video" && (
              <p className="text-xs leading-5 text-zinc-500 sm:col-span-3">
                视频参数（时长 / 比例 / 分辨率 / 有声）与首帧图、尾帧图、参考素材已移到下方输入框工具栏，按模型能力动态显示。
              </p>
            )}

            {activeKind === "audio" && (
              <>
                <label className="text-xs text-zinc-400">
                  <span className="mb-1 block">音色</span>
                  <select
                    value={audVoice}
                    onChange={(e) => setAudVoice(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-2 py-1.5 text-xs text-zinc-300 outline-none focus:border-emerald-500"
                  >
                    <option value="女声">女声</option>
                    <option value="男声">男声</option>
                    <option value="童声">童声</option>
                  </select>
                </label>
                <label className="text-xs text-zinc-400">
                  <span className="mb-1 flex items-center justify-between">
                    语速
                    <span className="text-zinc-600">{audSpeed.toFixed(1)}x</span>
                  </span>
                  <input
                    type="range"
                    min={0.5}
                    max={2}
                    step={0.1}
                    value={audSpeed}
                    onChange={(e) => setAudSpeed(Number(e.target.value))}
                    className="w-full accent-emerald-500"
                  />
                </label>
                <label className="text-xs text-zinc-400">
                  <span className="mb-1 block">输出格式</span>
                  <select
                    value={audFormat}
                    onChange={(e) => setAudFormat(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-2 py-1.5 text-xs text-zinc-300 outline-none focus:border-emerald-500"
                  >
                    <option value="mp3">mp3</option>
                    <option value="wav">wav</option>
                  </select>
                </label>
              </>
            )}

            {currentModel && !currentModel.ready && (
              <p className="text-xs leading-5 text-amber-300/70 sm:col-span-3">
                该模型端点或定价未配置，生成通道未就绪。
              </p>
            )}
            {lockedKind && (
              <p className="text-xs leading-5 text-zinc-500 sm:col-span-3">
                创作类型由带入的提示词「{lockTitle}」决定：{KIND_LABEL[lockedKind]}，其他类型的模型已在
                下拉中置灰。
              </p>
            )}
              </div>
            )}
            {maintenance?.enabled && (
              <div className="mb-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
                🛠 {maintenance.message}
              </div>
            )}
            {/* M3：已挂载技能（素材由服务端注入，不占输入框） */}
            {skillBusy && (
              <p className="mb-2 text-xs text-zinc-500">正在准备技能素材…</p>
            )}
            {mountedSkill && (
              <div className="mb-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-emerald-200">
                  <span className="min-w-0 truncate">已挂载技能：{mountedSkill.name}</span>
                  <span className="shrink-0 text-emerald-300/60">素材由服务端注入</span>
                  <button
                    type="button"
                    onClick={() => setMountedSkill(null)}
                    aria-label="移除技能"
                    className="ml-auto shrink-0 text-emerald-300/70 transition hover:text-emerald-200"
                  >
                    ✕
                  </button>
                </div>
                {mountedSkill.note && (
                  <p className="mt-1 text-xs leading-5 text-amber-300/80">{mountedSkill.note}</p>
                )}
              </div>
            )}

            {/* 多段提示词：分段展示 + 逐段插入 */}
            {segments.length > 0 && (
              <div className="mb-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] p-2.5">
                <div className="flex items-center gap-2 text-xs text-emerald-200">
                  <span className="min-w-0 truncate">分段提示词：{segTitle}</span>
                  <span className="shrink-0 text-emerald-300/70">共 {segments.length} 段</span>
                  <button
                    type="button"
                    onClick={clearMaterial}
                    aria-label="移除分段提示词"
                    className="ml-auto shrink-0 text-emerald-300/70 transition hover:text-emerald-200"
                  >
                    ✕
                  </button>
                </div>

                {nextSeg ? (
                  <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-zinc-500">第 {nextSeg.no} 段</span>
                      {remainingCount > 1 && (
                        <span className="rounded-full bg-amber-400/10 px-1.5 py-0.5 text-amber-300">
                          下面还有 {remainingCount - 1} 段
                        </span>
                      )}
                      {insertedNos.length > 0 && (
                        <span className="text-emerald-400/80">已插入 {insertedNos.length} 段</span>
                      )}
                    </div>
                    <p className="mt-1 max-h-20 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-zinc-300">
                      {nextSeg.text}
                    </p>
                    <button
                      type="button"
                      onClick={() => insertSegment(nextSeg)}
                      className="mt-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/20"
                    >
                      插入第 {nextSeg.no} 段
                    </button>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-emerald-300/70">
                    全部 {segments.length} 段都已插入，可在输入框里继续编辑。
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => setSegExpanded((v) => !v)}
                  className="mt-2 text-xs text-emerald-300/80 transition hover:text-emerald-200"
                >
                  {segExpanded
                    ? "收起分段列表"
                    : `展开全部 ${segments.length} 段，选择插入`}
                </button>

                {segExpanded && (
                  <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto pr-0.5">
                    {segments.map((seg) => {
                      const used = insertedSet.has(seg.no);
                      return (
                        <div
                          key={seg.no}
                          className={`rounded-lg border p-2 ${
                            used
                              ? "border-emerald-500/20 bg-emerald-500/5"
                              : "border-zinc-800 bg-zinc-950/40"
                          }`}
                        >
                          <div className="flex items-center gap-2 text-xs">
                            <span className="text-zinc-500">第 {seg.no} 段</span>
                            {used && <span className="text-emerald-400/80">已插入</span>}
                            <button
                              type="button"
                              onClick={() => insertSegment(seg)}
                              className="ml-auto rounded-md border border-emerald-500/40 px-2 py-0.5 text-xs text-emerald-200 transition hover:bg-emerald-500/15"
                            >
                              插入
                            </button>
                          </div>
                          <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-zinc-400">
                            {seg.text}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {loadedPrompt && segments.length === 0 && (
              <div className="mb-2 inline-flex max-w-full items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200">
                <span className="min-w-0 truncate">已带入：{loadedPrompt.title}</span>
                <button
                  type="button"
                  onClick={() => void toggleFavorite()}
                  className="shrink-0 rounded-md border border-emerald-500/40 px-1.5 py-0.5 transition hover:bg-emerald-500/20"
                >
                  {loadedPrompt.favorited ? "★ 已收藏 · 点击取消" : "☆ 收藏"}
                </button>
                <button
                  type="button"
                  onClick={() => setLoadedPrompt(null)}
                  aria-label="移除带入标记"
                  className="shrink-0 text-emerald-300/70 transition hover:text-emerald-200"
                >
                  ✕
                </button>
              </div>
            )}
            <div className="group relative flex flex-col rounded-[22px] border border-zinc-800/80 bg-zinc-950/80 p-3 shadow-[0_16px_50px_-18px_rgba(0,0,0,0.85)] transition-[border-color,box-shadow] duration-200 focus-within:border-emerald-500/45 focus-within:shadow-[0_20px_60px_-18px_rgba(16,185,129,0.25)]">
              {/* 聚焦时顶部高光：纯装饰 */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/60 to-transparent opacity-0 transition-opacity duration-300 group-focus-within:opacity-100"
              />
              {/* 视频素材：首尾帧 / 参考图 / 参考视频（按能力矩阵显示，互斥使用） */}
              {activeKind === "video" && vidCap && (
                <div
                  className="mb-1.5 space-y-1.5 px-1"
                  onClickCapture={(e) => {
                    // 游客（含试玩中）：素材上传会持久化文件，必须先登录
                    if (!loggedIn) {
                      e.preventDefault();
                      e.stopPropagation();
                      goAuth();
                    }
                  }}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    {vidCap.firstFrame && (
                      <MediaChip
                        label="首帧图"
                        accept={imageAccept}
                        url={vidFirst}
                        uploading={vidUploading === "first"}
                        disabled={busy || !imageAccept || vidRefImages.length + vidRefVideos.length > 0}
                        hint="首帧图；与参考素材互斥"
                        onPick={(f) => void uploadVideoAsset(f, "first")}
                        onClear={() => setVidFirst(null)}
                      />
                    )}
                    {vidCap.lastFrame && (
                      <MediaChip
                        label="尾帧图"
                        accept={imageAccept}
                        url={vidLast}
                        uploading={vidUploading === "last"}
                        disabled={busy || !imageAccept || vidRefImages.length + vidRefVideos.length > 0}
                        hint="可选尾帧图；与参考素材互斥"
                        onPick={(f) => void uploadVideoAsset(f, "last")}
                        onClear={() => setVidLast(null)}
                      />
                    )}
                    {refImageCap > 0 && (
                      <MediaChip
                        label={`参考图 ${vidRefImages.length}/${refImageCap}`}
                        accept={imageAccept}
                        url={null}
                        uploading={vidUploading === "image"}
                        disabled={busy || !imageAccept || vidHasFrame}
                        hint="参考图；与首帧图/尾帧图互斥"
                        onPick={(f) => void uploadVideoAsset(f, "image")}
                        onClear={() => setVidRefImages([])}
                      />
                    )}
                    {refVideoCap > 0 && (
                      <MediaChip
                        label={`输入视频 ${vidRefVideos.length}/${refVideoCap}`}
                        accept={videoAccept}
                        url={null}
                        uploading={vidUploading === "video"}
                        disabled={busy || !videoAccept || vidHasFrame}
                        hint="参考视频；与首帧图/尾帧图互斥"
                        onPick={(f) => void uploadVideoAsset(f, "video")}
                        onClear={() => setVidRefVideos([])}
                      />
                    )}
                  </div>
                  {/* 参考素材预览（可逐个移除） */}
                  {(vidRefImages.length > 0 || vidRefVideos.length > 0) && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {vidRefImages.map((url, i) => (
                        <span key={`ri-${i}`} className="relative inline-flex">
                          <img
                            src={url}
                            alt={`参考图 ${i + 1}`}
                            className="h-10 w-10 rounded-md border border-zinc-700 object-cover"
                          />
                          <button
                            type="button"
                            aria-label={`移除参考图 ${i + 1}`}
                            onClick={() => setVidRefImages((prev) => prev.filter((_, j) => j !== i))}
                            className="absolute -right-1 -top-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900 text-xs text-zinc-300 hover:border-red-500/60 hover:text-red-300"
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                      {vidRefVideos.map((url, i) => (
                        <span key={`rv-${i}`} className="relative inline-flex">
                          <span className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 text-xs text-zinc-300">
                            视频
                          </span>
                          <button
                            type="button"
                            aria-label={`移除参考视频 ${i + 1}`}
                            onClick={() => setVidRefVideos((prev) => prev.filter((_, j) => j !== i))}
                            className="absolute -right-1 -top-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900 text-xs text-zinc-300 hover:border-red-500/60 hover:text-red-300"
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {vidHasFrame && (
                    <p className="text-xs text-zinc-600">
                      已选首帧图/尾帧图：画幅自动跟随素材（自适应），参考图与参考视频暂不可同时使用。
                    </p>
                  )}
                </div>
              )}
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={2}
                maxLength={20000}
                placeholder={
                  activeKind === "video"
                    ? "描述你想生成的画面与运镜…"
                    : "输入你的问题，或从下方推荐里挑一个试试…"
                }
                className="max-h-40 min-h-[76px] w-full resize-none bg-transparent px-1.5 py-1 text-sm leading-7 text-zinc-100 outline-none placeholder:text-zinc-600"
              />
              {/* 第三排：字数与发送 */}
              <div className="mt-1 flex items-end justify-between gap-3 px-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 pb-0.5">
                  <span
                    className={`text-xs tabular-nums transition-colors ${
                      input.length > 18000 ? "text-amber-400" : "text-zinc-500"
                    }`}
                  >
                    {input.length} / 20000
                  </span>
                  <span className="hidden text-xs text-zinc-600 sm:inline">
                    Enter 发送 · Shift+Enter 换行
                  </span>
                </div>
                {busy ? (
                  <button
                    type="button"
                    onClick={stop}
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 text-xs font-medium text-rose-300 transition hover:border-rose-400/60 hover:bg-rose-500/20 active:scale-[0.97]"
                  >
                    <span className="inline-block h-3 w-3 rounded-[3px] bg-rose-400" />
                    停止
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => send()}
                    disabled={!input.trim() || !!maintenance?.enabled}
                    className="group/send inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 text-xs font-semibold text-white shadow-[0_10px_26px_-8px_rgba(16,185,129,0.7)] transition-[filter,box-shadow,transform] duration-150 hover:brightness-110 hover:shadow-[0_12px_30px_-8px_rgba(16,185,129,0.85)] active:scale-[0.97] disabled:cursor-not-allowed disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 disabled:shadow-none"
                  >
                    {activeKind === "video" ? "生成" : "发送"}
                    <svg
                      viewBox="0 0 24 24"
                      className="h-3.5 w-3.5 transition-transform duration-150 group-hover/send:translate-x-0.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M5 12h13M13 6l6 6-6 6" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="order-first mb-2.5 flex flex-wrap items-center gap-1.5 border-b border-zinc-800/60 pb-2.5">
                {/* 模型选择：自绘外壳（图标 + 原生下拉 + chevron），下拉内容仍是原生 optgroup */}
                <label className="inline-flex h-9 min-w-0 items-center gap-2 rounded-xl border border-zinc-700/70 bg-zinc-900/60 pl-2.5 pr-2 transition-[border-color,background-color,box-shadow] duration-150 hover:border-zinc-600 hover:bg-zinc-900 focus-within:border-emerald-500/60 focus-within:ring-2 focus-within:ring-emerald-500/15">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-3.5 w-3.5 shrink-0 text-emerald-300/80"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
                  </svg>
                  <select
                    aria-label="选择模型"
                    value={model}
                    onChange={(e) => {
                      if (blockGuest()) return;
                      setModel(e.target.value);
                    }}
                    disabled={busy}
                    className="h-full min-w-0 max-w-[168px] cursor-pointer appearance-none truncate bg-transparent pr-0.5 text-xs font-medium text-zinc-200 outline-none disabled:cursor-not-allowed disabled:text-zinc-500"
                  >
                  {MODEL_KINDS.map((k) => {
                    const group = models.filter((m) => m.kind === k);
                    if (!group.length) return null;
                    // 后台设定的默认图片 / 视频模型排在该组第一位
                    const wanted = k === "image" ? defaultModels.image : k === "video" ? defaultModels.video : "";
                    const ordered = [...group].sort(
                      (a, b) => (a.name === wanted ? 0 : 1) - (b.name === wanted ? 0 : 1)
                    );
                    return (
                      <optgroup key={k} label={KIND_LABEL[k]}>
                        {ordered.map((m) => (
                          <option
                            key={m.id}
                            value={m.name}
                            disabled={!!lockedKind && m.kind !== lockedKind}
                          >
                            {m.displayName || m.name}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                  </select>
                  <svg
                    viewBox="0 0 24 24"
                    className="pointer-events-none h-3 w-3 shrink-0 text-zinc-500"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </label>
                {activeKind !== "video" && (
                  <button
                    type="button"
                    onClick={() => {
                      if (blockGuest()) return;
                      setShowParams((v) => !v);
                    }}
                    aria-pressed={showParams}
                    className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-medium transition-[border-color,background-color,color] duration-150 ${
                      showParams
                        ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                        : "border-zinc-700/70 text-zinc-400 hover:border-zinc-600 hover:bg-zinc-900 hover:text-zinc-200"
                    }`}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      aria-hidden
                    >
                      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
                      <circle cx="16" cy="7" r="2" />
                      <circle cx="10" cy="17" r="2" />
                    </svg>
                    参数
                  </button>
                )}
                {activeKind === "video" && vidCap && (
                  <>
                    <ToolMenu
                      value={String(vidDuration)}
                      onChange={(v) => {
                        if (blockGuest() || lockDefaults) return;
                        setVidDuration(Number(v));
                      }}
                      disabled={lockDefaults}
                      title={lockDefaults ? "后台已锁定默认参数" : "视频时长"}
                      options={durationOptions(vidCap).map((s) => ({
                        value: String(s),
                        label: `${s} 秒`,
                      }))}
                    />
                    <ToolMenu
                      value={vidHasFrame ? "adaptive" : vidRatio}
                      onChange={(v) => {
                        if (blockGuest() || lockDefaults) return;
                        setVidRatio(v);
                      }}
                      disabled={vidHasFrame || lockDefaults}
                      title={
                        lockDefaults
                          ? "后台已锁定默认参数"
                          : vidHasFrame
                            ? "首帧图/尾帧图任务的画幅自动跟随素材"
                            : "画面比例"
                      }
                      options={vidCap.ratios.map((r) => ({
                        value: r,
                        label: r === "adaptive" ? "自适应" : r,
                        icon: <RatioIcon ratio={r} />,
                      }))}
                    />
                    <ToolMenu
                      value={vidResolution}
                      onChange={(v) => {
                        if (blockGuest() || lockDefaults) return;
                        setVidResolution(v);
                      }}
                      disabled={lockDefaults}
                      title={lockDefaults ? "后台已锁定默认参数" : "输出分辨率"}
                      options={vidCap.resolutions.map((r) => ({ value: r, label: r }))}
                    />
                    {vidCap.audioToggle && (
                      <ToolMenu
                        value={vidAudio ? "on" : "off"}
                        onChange={(v) => {
                          if (blockGuest() || lockDefaults) return;
                          setVidAudio(v === "on");
                        }}
                        disabled={lockDefaults}
                        title={lockDefaults ? "后台已锁定默认参数" : "是否生成声音"}
                        options={[
                          { value: "on", label: "有声" },
                          { value: "off", label: "无声" },
                        ]}
                      />
                    )}
                    {estimateMode === "live" && (
                      <span className="ml-auto pl-2 text-xs text-zinc-500">
                        {vidPerSecond != null && vidEstimate != null
                          ? `${vidPerSecond} 积分/秒 × ${vidDuration} 秒 = ${vidEstimate} 积分`
                          : "预计消耗待定价"}
                      </span>
                    )}
                    {estimateMode === "click" && submittedEstimate != null && (
                      <span className="ml-auto pl-2 text-xs text-emerald-400/80">
                        本次预计消耗 {submittedEstimate.credits} 积分（{submittedEstimate.perSecond} 积分/秒 ×{" "}
                        {submittedEstimate.seconds} 秒）
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
          </div>
        </div>
      </div>
    </div>
  );
}
