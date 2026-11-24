// vp5/vp1 视频转码的纯参数层（不引用 node:child_process，便于单测）。
// 实际执行见 video-transcode.server.ts。

import type { VideoAction } from "./video-codec";

// 资源与画质上限（用户确认口径）：
// - crf 21，1080p 上限不放大，AAC 128k
// - 4 核 / 4G 内存、nice 19 + ionice idle、并发 1–2、超时 10 分钟
export const VIDEO_TRANSCODE_LIMITS = {
  crf: 21,
  preset: "veryfast",
  maxLongEdge: 1920,
  audioBitrate: "128k",
  audioChannels: 2,
  audioSampleRate: 44100,
  threads: 4,
  /** prlimit --as：4G */
  memoryBytes: 4 * 1024 * 1024 * 1024,
  timeoutMs: 10 * 60 * 1000,
  concurrencyDefault: 1,
  concurrencyMax: 2,
} as const;

// 缩放边界框：不放大（min 截断），等比缩小，宽高取偶以适配 yuv420p
const SCALE_FILTER =
  "scale=w='min(iw,1920)':h='min(ih,1920)':force_original_aspect_ratio=decrease:force_divisible_by=2";

const INPUT_ARGS = ["-nostdin", "-loglevel", "error", "-y"];
const THREAD_ARGS = [
  "-threads",
  String(VIDEO_TRANSCODE_LIMITS.threads),
  "-filter_threads",
  String(VIDEO_TRANSCODE_LIMITS.threads),
  "-filter_complex_threads",
  String(VIDEO_TRANSCODE_LIMITS.threads),
];
const FASTSTART_ARGS = ["-movflags", "+faststart"];

/** 仅重新封装：不解码、不改画质，只为把 moov 挪到文件头 */
export function buildRemuxArgs(input: string, output: string): string[] {
  return [...INPUT_ARGS, "-i", input, "-map", "0", "-c", "copy", ...FASTSTART_ARGS, "-f", "mp4", output];
}

/** 重编码为 H.264 8-bit（yuv420p）+ AAC，产物 mp4 + faststart */
export function buildTranscodeArgs(input: string, output: string): string[] {
  return [
    ...INPUT_ARGS,
    "-i",
    input,
    // 只保留首条视频轨与首条音轨（音轨可缺省）；字幕/数据轨不进 mp4
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    VIDEO_TRANSCODE_LIMITS.preset,
    "-crf",
    String(VIDEO_TRANSCODE_LIMITS.crf),
    "-profile:v",
    "high",
    "-level:v",
    "4.2",
    "-pix_fmt",
    "yuv420p",
    "-vf",
    SCALE_FILTER,
    "-c:a",
    "aac",
    "-b:a",
    VIDEO_TRANSCODE_LIMITS.audioBitrate,
    "-ac",
    String(VIDEO_TRANSCODE_LIMITS.audioChannels),
    "-ar",
    String(VIDEO_TRANSCODE_LIMITS.audioSampleRate),
    ...THREAD_ARGS,
    "-max_muxing_queue_size",
    "1024",
    ...FASTSTART_ARGS,
    "-f",
    "mp4",
    output,
  ];
}

const RESOURCE_PREFIX = [
  "nice",
  "-n",
  "19",
  "ionice",
  "-c",
  "3",
  "-n",
  "7",
  "prlimit",
  `--as=${VIDEO_TRANSCODE_LIMITS.memoryBytes}`,
  "--",
];

/**
 * 组装最终执行的命令。
 * Linux 上串 nice → ionice → prlimit（cgroup 之外的兜底资源限制）；其他平台直跑 ffmpeg。
 */
export function buildFfmpegCommand(
  ffmpegBin: string,
  action: Exclude<VideoAction, "pass">,
  input: string,
  output: string,
  platform: string = process.platform
): { file: string; args: string[] } {
  const args = action === "remux" ? buildRemuxArgs(input, output) : buildTranscodeArgs(input, output);
  if (platform !== "linux") return { file: ffmpegBin, args };
  return { file: RESOURCE_PREFIX[0], args: [...RESOURCE_PREFIX.slice(1), ffmpegBin, ...args] };
}

/** 并发上限：默认 1，允许 1–2；非法值一律回落到 1（宁可慢，不拖垮站点） */
export function resolveTranscodeConcurrency(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return VIDEO_TRANSCODE_LIMITS.concurrencyDefault;
  const int = Math.trunc(n);
  if (int < 1) return VIDEO_TRANSCODE_LIMITS.concurrencyDefault;
  return Math.min(VIDEO_TRANSCODE_LIMITS.concurrencyMax, int);
}
