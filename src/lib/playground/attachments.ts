import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { FirstFrameError, normalizeFirstFramePath } from "./first-frame";

// ─── 视频多模态素材（首帧 / 尾帧 / 参考图 / 参考视频） ───
// 与首帧图同一套安全边界：只接受本站 /api/upload 产出的 /uploads/ 地址，
// 拒绝外链，避免把网关变成任意 URL 拉取器。
// 上游取值：图片沿用 data URL（不依赖站点是否对外可达）；
// 视频体积大，优先拼成站点绝对地址（SITE_URL），本地无域名时才回退 data URL。

const VIDEO_EXT_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

const IMAGE_EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/** 参考素材角色（与 Ark content[].role 对应） */
export type AttachmentRole = "first_frame" | "last_frame" | "reference_image" | "reference_video";

export interface PlaygroundAttachment {
  role: AttachmentRole;
  url: string;
}

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

function absolutePathOf(url: string): string {
  const root = path.resolve(process.cwd(), "public", "uploads");
  const abs = path.resolve(process.cwd(), "public", url.replace(/^\//, ""));
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new FirstFrameError("invalid_attachment_url", "素材地址不合法");
  }
  return abs;
}

/**
 * 校验并归一化素材地址：图片走首帧同一套规则，视频额外放行 mp4/webm/mov。
 * 返回可直接落库/传给 worker 的站内路径。
 */
export function normalizeAttachmentPath(raw: string, media: "image" | "video"): string {
  if (media === "image") return normalizeFirstFramePath(raw);
  const url = raw.trim();
  if (!url.startsWith("/uploads/")) {
    throw new FirstFrameError("invalid_attachment_url", "参考视频必须是本站上传的地址");
  }
  if (url.includes("..") || url.includes("\\") || url.includes("//") || url.includes("?") || url.includes("#")) {
    throw new FirstFrameError("invalid_attachment_url", "素材地址不合法");
  }
  const ext = path.extname(url).slice(1).toLowerCase();
  if (!VIDEO_EXT_MIME[ext]) {
    throw new FirstFrameError("invalid_attachment_url", "参考视频仅支持 mp4 / webm / mov");
  }
  return url;
}

/** 创建任务时预检文件存在（失败 400，不扣分） */
export async function assertAttachmentFile(url: string): Promise<void> {
  const abs = absolutePathOf(url);
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new FirstFrameError("attachment_missing", "素材已失效，请重新上传");
  }
  if (!info.isFile() || info.size <= 0) {
    throw new FirstFrameError("attachment_missing", "素材内容为空，请重新上传");
  }
  const ext = path.extname(abs).slice(1).toLowerCase();
  const limit = VIDEO_EXT_MIME[ext] ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (info.size > limit) {
    throw new FirstFrameError("attachment_too_large", "素材文件过大，请压缩后重试");
  }
}

/**
 * 转成上游可直接消费的地址：
 * 1) 配了 NEXT_PUBLIC_SITE_URL → 绝对地址（Ark 侧自行拉取，视频/图片都适用）
 * 2) 否则图片走 data URL（本地开发也能跑通），视频没有可公开地址时直接报错
 */
export async function attachmentUpstreamUrl(url: string): Promise<string> {
  const site = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/+$/, "");
  if (/^https?:\/\//.test(site)) return `${site}${url}`;

  const abs = absolutePathOf(url);
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mime = IMAGE_EXT_MIME[ext];
  if (!mime) {
    throw new FirstFrameError(
      "attachment_unreachable",
      "参考视频需要配置站点域名（NEXT_PUBLIC_SITE_URL）后由上游拉取"
    );
  }
  const bytes = await readFile(abs);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

// ─── 参考视频时长校验 ───
// 上游（火山方舟）硬上限 30.2s；本站取 30s 保守值，在创建任务与 worker 执行两处都挡。
// 只读文件头/尾各 16MB 做探针（不把 200MB 视频整体读进内存）：
//   MP4 / MOV：扫描 mvhd（timescale + duration）
//   WebM：扫描 Info 里的 Duration（单位 = TimecodeScale，默认 1ms）
// 解析不到时按「无法读取时长」明确报错，不默认放过。

export const MAX_REFERENCE_VIDEO_SECONDS = 30;
const VIDEO_PROBE_BYTES = 16 * 1024 * 1024;

async function readProbeChunks(abs: string): Promise<Buffer[]> {
  const fh = await open(abs, "r");
  try {
    const { size } = await fh.stat();
    const headLen = Math.min(size, VIDEO_PROBE_BYTES);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    const chunks = [head];
    if (size > headLen) {
      const tailLen = Math.min(size, VIDEO_PROBE_BYTES);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      chunks.push(tail);
    }
    return chunks;
  } finally {
    await fh.close();
  }
}

// MP4 / MOV：mvhd 里 duration / timescale 即总时长（秒）
function findMp4Duration(buf: Buffer): number | null {
  for (let i = 4; i + 24 < buf.length; i++) {
    if (buf[i] !== 0x6d || buf[i + 1] !== 0x76 || buf[i + 2] !== 0x68 || buf[i + 3] !== 0x64) continue;
    const base = i + 4; // mvhd box 内容起点（version 1 字节 + flags 3 字节）
    if (buf[base] === 1) {
      if (base + 32 > buf.length) continue;
      const timescale = buf.readUInt32BE(base + 20);
      const duration = Number(buf.readBigUInt64BE(base + 24));
      if (timescale > 0 && duration > 0) {
        const seconds = duration / timescale;
        if (Number.isFinite(seconds) && seconds > 0 && seconds < 86_400) return seconds;
      }
    } else {
      const timescale = buf.readUInt32BE(base + 12);
      const duration = buf.readUInt32BE(base + 16);
      if (timescale > 0 && duration > 0) {
        const seconds = duration / timescale;
        if (Number.isFinite(seconds) && seconds > 0 && seconds < 86_400) return seconds;
      }
    }
  }
  return null;
}

// WebM：先找 TimecodeScale（ns，默认 1ms），再找 Duration（浮点）
function findWebmDuration(buf: Buffer): number | null {
  let scale = 1_000_000;
  for (let i = 0; i + 6 < buf.length; i++) {
    if (buf[i] === 0x2a && buf[i + 1] === 0xd7 && buf[i + 2] === 0xb1) {
      const sizeByte = buf[i + 3];
      const len = sizeByte === 0x84 ? 4 : sizeByte === 0x83 ? 3 : 0;
      if (len && i + 4 + len <= buf.length) {
        let ns = 0;
        for (let k = 0; k < len; k++) ns = ns * 256 + buf[i + 4 + k];
        if (ns > 0 && ns <= 1e9) scale = ns;
        break;
      }
    }
  }
  for (let i = 0; i + 12 < buf.length; i++) {
    if (buf[i] !== 0x44 || buf[i + 1] !== 0x89) continue;
    const sizeByte = buf[i + 2];
    const len = sizeByte === 0x84 ? 4 : sizeByte === 0x88 ? 8 : 0;
    if (!len || i + 3 + len > buf.length) continue;
    const value = len === 4 ? buf.readFloatBE(i + 3) : buf.readDoubleBE(i + 3);
    if (!Number.isFinite(value) || value <= 0) continue;
    const seconds = (value * scale) / 1e9;
    if (seconds > 0 && seconds < 86_400) return seconds;
  }
  return null;
}

/** 从缓冲区（文件头/尾探针）读视频时长；MP4/MOV 与 WebM 都支持，解析不到返回 null */
export function videoDurationFromBuffer(chunks: Buffer[]): number | null {
  for (const chunk of chunks) {
    const seconds = findMp4Duration(chunk) ?? findWebmDuration(chunk);
    if (seconds != null) return seconds;
  }
  return null;
}

/** 从 MP4/MOV/WebM 文件头尾探针读时长（秒）；解析不到返回 null */
export async function referenceVideoDuration(url: string): Promise<number | null> {
  const abs = absolutePathOf(url);
  const chunks = await readProbeChunks(abs).catch(() => null);
  if (!chunks) throw new FirstFrameError("attachment_missing", "参考视频已失效，请重新上传");
  return videoDurationFromBuffer(chunks);
}

/** 参考视频时长校验：超过上限或读不到时长都明确报错（不默认放过） */
export async function assertReferenceVideoDuration(
  url: string,
  limit = MAX_REFERENCE_VIDEO_SECONDS
): Promise<void> {
  const seconds = await referenceVideoDuration(url);
  if (seconds == null) {
    throw new FirstFrameError(
      "video_duration_unreadable",
      "无法读取参考视频时长，请转成标准 MP4（H.264）后重试"
    );
  }
  if (seconds > limit) {
    throw new FirstFrameError(
      "video_too_long",
      `参考视频时长不能超过 ${limit} 秒（当前 ${seconds.toFixed(1)} 秒）`
    );
  }
}
