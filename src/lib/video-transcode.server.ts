import "server-only";

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ensureTmpDir } from "./tmp-dir.server";
import type { VideoAction } from "./video-codec";
import {
  buildFfmpegCommand,
  resolveTranscodeConcurrency,
  VIDEO_TRANSCODE_LIMITS,
} from "./video-transcode";

// vp5/vp1 转码执行器：并发信号量 + 10 分钟超时 + Linux 资源包装。
// 只被用户上传（upload-core.server）与采集落盘（crawl-worker）调用；
// 不负责删除输入/输出临时文件之外的事情（落盘由调用方决定）。

const execFileP = promisify(execFile);

// 服务器可用绝对路径覆盖；FFMPEG_PATH 与采集链路既有变量保持兼容
const FFMPEG_BIN = process.env.FFMPEG_PATH || process.env.FFMPEG_BIN || "ffmpeg";

const MAX_CONCURRENT = resolveTranscodeConcurrency(process.env.VIDEO_TRANSCODE_CONCURRENCY);

// 并发为「名额转交」语义：release 时若有等待者直接转让名额，running 不回落
let running = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) {
    next();
    return;
  }
  running--;
}

function errorText(e: unknown): string {
  const err = e as any;
  const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
  const message = String(err?.message || e || "unknown error");
  return (stderr || message).slice(0, 400);
}

async function runFfmpeg(action: Exclude<VideoAction, "pass">, input: string, output: string): Promise<void> {
  const cmd = buildFfmpegCommand(FFMPEG_BIN, action, input, output);
  try {
    await execFileP(cmd.file, cmd.args, {
      timeout: VIDEO_TRANSCODE_LIMITS.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (e: any) {
    // 服务器缺 nice/ionice/prlimit 时退回直跑 ffmpeg，仍受并发与超时约束
    if (e?.code === "ENOENT" && cmd.file !== FFMPEG_BIN) {
      const plain = buildFfmpegCommand(FFMPEG_BIN, action, input, output, "win32");
      await execFileP(plain.file, plain.args, {
        timeout: VIDEO_TRANSCODE_LIMITS.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      return;
    }
    throw new Error(`ffmpeg ${action} 失败：${errorText(e)}`);
  }
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * 对已落盘的视频文件执行 remux / transcode，返回产物临时文件绝对路径。
 * 调用方负责在落盘后删除输出文件（与输入文件）。
 */
export async function transcodeVideoFile(
  action: Exclude<VideoAction, "pass">,
  inputPath: string
): Promise<string> {
  const output = path.join(
    ensureTmpDir(),
    `vp5-${process.pid}-${crypto.randomBytes(6).toString("hex")}.mp4`
  );
  try {
    await withSlot(() => runFfmpeg(action, inputPath, output));
    return output;
  } catch (e) {
    await rm(output, { force: true }).catch(() => {});
    throw e;
  }
}

/** 对内存中的视频字节执行 remux / transcode，返回产物字节（上传链路使用） */
export async function transcodeVideoBuffer(
  action: Exclude<VideoAction, "pass">,
  bytes: Buffer
): Promise<Buffer> {
  const dir = await mkdtemp(path.join(ensureTmpDir(), "vp5-"));
  const input = path.join(dir, "input");
  const output = path.join(dir, "output.mp4");
  try {
    await writeFile(input, bytes);
    await withSlot(() => runFfmpeg(action, input, output));
    const out = await readFile(output);
    if (out.length === 0) throw new Error("ffmpeg 未产出文件");
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
