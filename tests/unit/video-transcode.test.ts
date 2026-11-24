import { describe, it, expect } from "vitest";
import {
  buildFfmpegCommand,
  buildRemuxArgs,
  buildTranscodeArgs,
  resolveTranscodeConcurrency,
  VIDEO_TRANSCODE_LIMITS,
} from "@/lib/video-transcode";

// ─── vp5/vp1 转码参数与资源限制（纯函数，不执行 ffmpeg） ───

const IN = "/tmp/in.mp4";
const OUT = "/tmp/out.mp4";

describe("buildRemuxArgs", () => {
  it("只做 -c copy + faststart，不带任何重编码参数", () => {
    const args = buildRemuxArgs(IN, OUT);
    expect(args).toEqual(
      expect.arrayContaining(["-i", IN, "-map", "0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", OUT])
    );
    expect(args.join(" ")).not.toContain("libx264");
    expect(args.join(" ")).not.toContain("-crf");
  });
});

describe("buildTranscodeArgs", () => {
  const args = buildTranscodeArgs(IN, OUT);
  const line = args.join(" ");

  it("画质口径：crf 21 / veryfast / High@4.2 / yuv420p / AAC 128k 立体声", () => {
    expect(line).toContain("-c:v libx264");
    expect(line).toContain("-crf 21");
    expect(line).toContain("-preset veryfast");
    expect(line).toContain("-profile:v high");
    expect(line).toContain("-level:v 4.2");
    expect(line).toContain("-pix_fmt yuv420p");
    expect(line).toContain("-c:a aac");
    expect(line).toContain("-b:a 128k");
    expect(line).toContain("-ac 2");
    expect(line).toContain("-ar 44100");
  });

  it("不放大：缩放边界框最长边 1920 且等比缩小、取偶", () => {
    expect(line).toContain("min(iw,1920)");
    expect(line).toContain("min(ih,1920)");
    expect(line).toContain("force_original_aspect_ratio=decrease");
    expect(line).toContain("force_divisible_by=2");
  });

  it("资源上限：4 线程（含 filter）+ faststart + 只保留首视频/首音频轨", () => {
    expect(line).toContain("-threads 4");
    expect(line).toContain("-filter_threads 4");
    expect(line).toContain("-filter_complex_threads 4");
    expect(line).toContain("-movflags +faststart");
    expect(line).toContain("-map 0:v:0");
    expect(line).toContain("-map 0:a:0?");
  });
});

describe("buildFfmpegCommand 资源包装", () => {
  it("Linux：nice 19 → ionice idle → prlimit 4G → ffmpeg", () => {
    const cmd = buildFfmpegCommand("/opt/ffmpeg-static/current/bin/ffmpeg", "transcode", IN, OUT, "linux");
    expect(cmd.file).toBe("nice");
    expect(cmd.args.slice(0, 10)).toEqual([
      "-n",
      "19",
      "ionice",
      "-c",
      "3",
      "-n",
      "7",
      "prlimit",
      "--as=4294967296",
      "--",
    ]);
    expect(cmd.args).toContain("/opt/ffmpeg-static/current/bin/ffmpeg");
    expect(cmd.args).toContain("-crf");
  });

  it("非 Linux：直跑 ffmpeg（本地开发机没有 nice/ionice/prlimit）", () => {
    const cmd = buildFfmpegCommand("ffmpeg", "remux", IN, OUT, "win32");
    expect(cmd.file).toBe("ffmpeg");
    expect(cmd.args[0]).toBe("-nostdin");
    expect(cmd.args).toContain("-c");
  });
});

describe("resolveTranscodeConcurrency", () => {
  it("默认 1；允许 1–2；非法/过大一律夹回上限", () => {
    expect(resolveTranscodeConcurrency(undefined)).toBe(1);
    expect(resolveTranscodeConcurrency("1")).toBe(1);
    expect(resolveTranscodeConcurrency("2")).toBe(2);
    expect(resolveTranscodeConcurrency("8")).toBe(2);
    expect(resolveTranscodeConcurrency("0")).toBe(1);
    expect(resolveTranscodeConcurrency("-3")).toBe(1);
    expect(resolveTranscodeConcurrency("abc")).toBe(1);
  });

  it("常量口径固定：crf 21 / 1080p / 4G / 10 分钟 / 并发上限 2", () => {
    expect(VIDEO_TRANSCODE_LIMITS.crf).toBe(21);
    expect(VIDEO_TRANSCODE_LIMITS.maxLongEdge).toBe(1920);
    expect(VIDEO_TRANSCODE_LIMITS.memoryBytes).toBe(4294967296);
    expect(VIDEO_TRANSCODE_LIMITS.timeoutMs).toBe(600000);
    expect(VIDEO_TRANSCODE_LIMITS.concurrencyMax).toBe(2);
  });
});
