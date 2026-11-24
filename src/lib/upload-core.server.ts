import "server-only";

import { saveUpload } from "./upload-store.server";
import { extOfFileName } from "./upload-naming";
import { decideVideoAction, inspectVideoSource } from "./video-codec";
import { transcodeVideoBuffer } from "./video-transcode.server";

// 用户媒体上传的统一服务端核心：类型识别（magic-byte）→ 校验 → 落盘。
// /api/upload（单文件，前端批量时并发调用）复用本模块；头像/品牌图因处理逻辑不同走各自路由。

export type MediaKind = "jpg" | "png" | "webp" | "gif" | "mp4" | "webm";

export class UploadError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const IMAGE_MIME: Record<string, boolean> = {
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
  "image/gif": true,
};
const VIDEO_MIME: Record<string, boolean> = {
  "video/mp4": true,
  "video/webm": true,
  "video/quicktime": true,
};

const KIND_EXT: Record<MediaKind, string> = {
  jpg: ".jpg",
  png: ".png",
  webp: ".webp",
  gif: ".gif",
  mp4: ".mp4", // .mov 与 mp4 同属 ftyp 系列，统一存 .mp4 可正常播放
  webm: ".webm", // WebM 原样通过（iPhone Safari 实测可播），保留真实后缀
};
const IMAGE_KINDS: MediaKind[] = ["jpg", "png", "webp", "gif"];
const VIDEO_KINDS: MediaKind[] = ["mp4", "webm"];

// vp5：用户上传视频后缀白名单。MOV 与 MP4 同属 ftyp 容器，WebM 原样通过；
// 其余视频后缀（avi/mkv/m4v 等）一律拒绝，并明确提示支持的格式。
const VIDEO_ACCEPT_EXT = new Set(["mp4", "mov", "webm"]);
const OTHER_VIDEO_EXT = new Set([
  "avi", "mkv", "flv", "wmv", "m4v", "3gp", "3g2", "ts", "mts", "m2ts", "mpg", "mpeg", "rmvb", "ogv", "mxf", "asf",
]);
const VIDEO_FORMAT_HINT = "视频仅支持 MP4 / MOV / WEBM 格式，请先转换为上述格式后再上传。";

/** 通过文件头签名识别真实类型，绝不信任浏览器给的 Content-Type */
export function sniffKind(buf: Buffer): MediaKind | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "png";
  const head6 = buf.subarray(0, 6).toString("ascii");
  if (head6 === "GIF87a" || head6 === "GIF89a") return "gif";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP")
    return "webp";
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "webm";
  if (buf.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
  return null;
}

export type SavedMedia = { url: string; type: "image" | "video"; size: number };

/**
 * 校验并保存一个用户上传的图片/视频到 public/uploads/YYYY-MM/。
 * 任何校验失败抛 UploadError（含 HTTP 状态码与中文/英文信息）。
 */
export async function saveUserMedia(
  file: File,
  opts: {
    maxImageMB: number;
    maxVideoMB: number;
    /** 实验场可配格式（按文件头识别结果匹配；省略 = 不额外限制） */
    allowedImageKinds?: string[];
    allowedVideoKinds?: string[];
  }
): Promise<SavedMedia> {
  const ext = extOfFileName(file.name);
  const claimedImage = !!IMAGE_MIME[file.type];
  const claimedVideo = !!VIDEO_MIME[file.type] || OTHER_VIDEO_EXT.has(ext);
  if (!claimedImage && !claimedVideo) {
    throw new UploadError(400, "unsupported type");
  }
  // vp5：视频只接受 MP4 / MOV / WEBM，其它后缀直接拒绝并提示支持格式
  if (claimedVideo && !VIDEO_ACCEPT_EXT.has(ext)) {
    throw new UploadError(400, VIDEO_FORMAT_HINT);
  }
  const limitMB = claimedImage ? opts.maxImageMB : opts.maxVideoMB;
  if (file.size < 12) throw new UploadError(400, "invalid file");
  if (file.size > limitMB * 1024 * 1024) {
    throw new UploadError(413, `file exceeds ${limitMB}MB`);
  }

  let bytes: Buffer = Buffer.from(await file.arrayBuffer());
  const kind = sniffKind(bytes);
  if (!kind) throw new UploadError(400, "file content not recognized");
  const realIsImage = IMAGE_KINDS.includes(kind);
  const realIsVideo = VIDEO_KINDS.includes(kind);
  if (claimedImage && !realIsImage) throw new UploadError(400, "type mismatch");
  if (claimedVideo && !realIsVideo) throw new UploadError(400, "type mismatch");

  // 实验场可配格式：按真实文件头识别出的 kind 判定，扩展名与声明类型都不作数
  const labelOf = (k: string) => (k === "jpg" ? "JPG" : k.toUpperCase());
  if (realIsImage && opts.allowedImageKinds && !opts.allowedImageKinds.includes(kind)) {
    throw new UploadError(
      400,
      `图片格式不支持：当前仅允许 ${opts.allowedImageKinds.map(labelOf).join(" / ")}`
    );
  }
  if (realIsVideo && opts.allowedVideoKinds && !opts.allowedVideoKinds.includes(kind)) {
    throw new UploadError(
      400,
      `视频格式不支持：当前仅允许 ${opts.allowedVideoKinds.map(labelOf).join(" / ")}（MOV 按 MP4 识别）`
    );
  }

  // vp5：只在需要时处理视频。
  // H.264 8-bit + faststart 正常 → 原样落盘（不解码、不 remux）；
  // 缺 faststart → -c copy 重封装；HEVC / 非 8-bit H.264 / ProRes / mp4v / MP4 内 AV1·VP9 → 转码；
  // WebM 原样通过。转码失败明确报错，不落任何文件。
  let finalSize = file.size;
  if (realIsVideo) {
    const action = decideVideoAction(inspectVideoSource(bytes));
    if (action !== "pass") {
      try {
        bytes = await transcodeVideoBuffer(action, bytes);
        finalSize = bytes.length;
      } catch (e) {
        console.error("[upload] video transcode failed:", e);
        const label = action === "remux" ? "重新封装" : "转码";
        throw new UploadError(422, `视频${label}失败，请重试或换用其他文件；若持续失败请联系管理员。`);
      }
    }
  }

  // 存储口径（白名单）：只有「后台技能压缩包」和「用户产物（generated_asset）」允许进默认桶。
  // 富文本图片/视频、提示词封面、头像、采集产物一律只落本地 public/uploads/YYYY-MM/，
  // 即使后台配了默认桶也不进桶 —— 桶按流量计费，只有体积小、数量少的两类才值得上云。
  // 统一落盘：类型名 + 时间刻度 + 随机 12 位，月份目录 YYYY-MM
  const saved = await saveUpload(realIsImage ? "image" : "video", KIND_EXT[kind], bytes);

  return {
    url: saved.url,
    type: realIsImage ? "image" : "video",
    size: finalSize,
  };
}
