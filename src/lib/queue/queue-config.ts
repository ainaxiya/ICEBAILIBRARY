// ─── P6 #22 队列并发配置（后台可改，代码里不留死常量）──
// 存 SiteSetting key="queue_config"，与告警阈值同一类配置。
// 五条通道各自独立：
//   video    : 视频任务消费线（网关 /v1/videos + 实验场视频共用一条线）
//   audio    : 音频生成（/v1/audio/speech）同时在途请求数
//   image    : 实验场图片生成通道（上游同步接口，单请求 1–2 分钟）
//   text     : 文本对话/流式请求同时在途数
//   download : 产物下载/转存（独立队列，大文件 IO）
// 生效方式：video/image/download 在 Worker 进程启动时确定，改动需重启 Worker；
//           audio/text 是进程内闸门，每次取号会读配置（5 秒缓存），保存后自动生效。

import { db } from "@/lib/db";

export const QUEUE_CONFIG_KEY = "queue_config";
export const QUEUE_LIMIT_MIN = 1;
export const QUEUE_LIMIT_MAX = 200;

export type QueueChannel = "video" | "audio" | "image" | "text" | "download";

export interface QueueConfig {
  video: number;
  audio: number;
  image: number;
  text: number;
  download: number;
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  video: 1,
  audio: 4,
  image: 8,
  text: 30,
  download: 2,
};

export interface QueueChannelMeta {
  key: QueueChannel;
  label: string;
  what: string;
  cost: string;
  restartRequired: boolean;
  effect: string;
}

// 后台展示文案：这一项是什么 / 调大的代价 / 是否需要重启
export const QUEUE_CHANNEL_META: QueueChannelMeta[] = [
  {
    key: "video",
    label: "视频任务线",
    what: "消费网关 /v1/videos 与实验场视频任务：提交上游、轮询状态、结束后收口。两类视频任务共用这一条线。",
    cost: "同时向上游提交/轮询更多视频任务。视频侧本身是轻量轮询，上游对视频并发限制较严，调大后更容易触发 429 与排队失败。",
    restartRequired: true,
    effect: "改完需重启 Worker 进程（pm2 restart CompletePrompt-Worker）才生效。",
  },
  {
    key: "image",
    label: "图片生成通道",
    what: "实验场图片生成。上游是同步接口，一次请求要等 1–2 分钟才返回，所以必须和状态轮询分开走。",
    cost: "每多一条线就多一个长请求与一份内存占用；上游图片并发限制更严，调大后失败率明显上升，同时也会更快消耗机器内存。",
    restartRequired: true,
    effect: "改完需重启 Worker 进程（pm2 restart CompletePrompt-Worker）才生效。",
  },
  {
    key: "audio",
    label: "音频生成并发",
    what: "音频合成（/v1/audio/speech）同时向上游发起的请求数。",
    cost: "同时占用更多上游 TTS 并发与内存；过高容易触发上游限流，失败重试也会变多。",
    restartRequired: false,
    effect: "保存后约 5 秒内自动生效，无需重启。",
  },
  {
    key: "text",
    label: "文本并发（含流式）",
    what: "文本对话请求同时在途上限（流式与非流式都算）；超出的请求排队等待，等不到才返回 429。",
    cost: "更多并发流会占用内存与上游 RPM；调得过高会触发上游限流，反而拉长整体耗时。",
    restartRequired: false,
    effect: "保存后约 5 秒内自动生效，无需重启。",
  },
  {
    key: "download",
    label: "产物下载并发",
    what: "视频产物下载与转存（大文件 IO），独立于状态轮询队列；补投的「成功但没有产物」任务也走这里。",
    cost: "更多并发下载占用带宽、磁盘/对象存储 IO 与内存；对上游存储限流敏感。",
    restartRequired: true,
    effect: "改完需重启 Worker 进程（pm2 restart CompletePrompt-Worker）才生效。",
  },
];

function clampLimit(v: unknown, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(QUEUE_LIMIT_MAX, Math.max(QUEUE_LIMIT_MIN, n));
}

// 任意来源（DB 旧值 / API 入参）→ 合法配置：逐项夹到 1–200，缺项回退默认值
export function normalizeQueueConfig(raw: unknown): QueueConfig {
  const p = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof QueueConfig, unknown>>;
  return {
    video: clampLimit(p.video, DEFAULT_QUEUE_CONFIG.video),
    audio: clampLimit(p.audio, DEFAULT_QUEUE_CONFIG.audio),
    image: clampLimit(p.image, DEFAULT_QUEUE_CONFIG.image),
    text: clampLimit(p.text, DEFAULT_QUEUE_CONFIG.text),
    download: clampLimit(p.download, DEFAULT_QUEUE_CONFIG.download),
  };
}

export async function getQueueConfig(): Promise<QueueConfig> {
  try {
    const row = await db.siteSetting.findUnique({ where: { key: QUEUE_CONFIG_KEY } });
    if (!row) return DEFAULT_QUEUE_CONFIG;
    return normalizeQueueConfig(JSON.parse(row.value));
  } catch {
    // 数据库抖动时不能把消费线卡死：回退默认值
    return DEFAULT_QUEUE_CONFIG;
  }
}

export interface SaveQueueConfigResult {
  config: QueueConfig;
  // 本次改动中「需要重启 Worker 才生效」的项（用于保存后明确提示）
  restartRequired: QueueChannelMeta[];
}

export async function saveQueueConfig(input: unknown): Promise<SaveQueueConfigResult> {
  const before = await getQueueConfig();
  const config = normalizeQueueConfig(input);
  await db.siteSetting.upsert({
    where: { key: QUEUE_CONFIG_KEY },
    update: { value: JSON.stringify(config) },
    create: { key: QUEUE_CONFIG_KEY, value: JSON.stringify(config) },
  });
  const restartRequired = QUEUE_CHANNEL_META.filter(
    (m) => m.restartRequired && config[m.key] !== before[m.key]
  );
  return { config, restartRequired };
}
