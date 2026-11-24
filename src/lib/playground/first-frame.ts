import { readFile, stat } from "node:fs/promises";
import path from "node:path";

// ─── 首帧图（图生视频）公共逻辑 ───
// 安全边界：只接受本站 /api/upload 产出的 /uploads/ 地址，拒绝任何外链/协议地址，
// 防止把网关当成任意 URL 的拉取器（SSRF / 外链注入）。
// 上游需要能取到图片：worker 读取本地文件后以 data URL 形式放进 image_url，
// 不依赖站点自身是否对外可访问（本地开发也能跑通同一条链路）。

const IMAGE_EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

// 单张首帧上限：与上传接口的图片上限同量级，防止把超大文件塞进上游 JSON
const MAX_FIRST_FRAME_BYTES = 16 * 1024 * 1024;

export type VideoRatioName = "16:9" | "9:16" | "1:1";

export class FirstFrameError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

/** 模型名判定：图生视频（首帧必填）。与模型库命名约定一致，如 seedance-2-0-image-to-video-basic。 */
export function isImageToVideoModel(name: string): boolean {
  return /image[-_]to[-_]video/i.test(name);
}

/** 校验并归一化首帧地址（只允许本站上传路径）。 */
export function normalizeFirstFramePath(raw: string): string {
  const url = raw.trim();
  if (!url.startsWith("/uploads/")) {
    throw new FirstFrameError("invalid_image_url", "首帧图必须是本站上传的图片地址");
  }
  if (url.includes("..") || url.includes("\\") || url.includes("//") || url.includes("?") || url.includes("#")) {
    throw new FirstFrameError("invalid_image_url", "首帧图地址不合法");
  }
  const ext = path.extname(url).slice(1).toLowerCase();
  if (!IMAGE_EXT_MIME[ext]) {
    throw new FirstFrameError("invalid_image_url", "首帧图仅支持 jpg / png / webp / gif");
  }
  return url;
}

function absolutePathOf(url: string): string {
  const root = path.resolve(process.cwd(), "public", "uploads");
  const abs = path.resolve(process.cwd(), "public", url.replace(/^\//, ""));
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new FirstFrameError("invalid_image_url", "首帧图地址不合法");
  }
  return abs;
}

async function assertFile(url: string): Promise<string> {
  const abs = absolutePathOf(url);
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new FirstFrameError("first_frame_missing", "首帧图已失效，请重新上传");
  }
  if (!info.isFile()) throw new FirstFrameError("first_frame_missing", "首帧图已失效，请重新上传");
  if (info.size <= 0) throw new FirstFrameError("first_frame_missing", "首帧图内容为空，请重新上传");
  if (info.size > MAX_FIRST_FRAME_BYTES) {
    throw new FirstFrameError("first_frame_too_large", "首帧图过大，请压缩后重试");
  }
  return abs;
}

/** 预检首帧文件是否存在且可读（创建任务时调用，失败直接 400，不扣分）。 */
export async function assertFirstFrameFile(url: string): Promise<void> {
  await assertFile(url);
}

/** 读取本地首帧并转成 data URL，供上游 image_url 使用。 */
export async function firstFrameDataUrl(url: string): Promise<string> {
  const abs = await assertFile(url);
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mime = IMAGE_EXT_MIME[ext] ?? "application/octet-stream";
  const bytes = await readFile(abs);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

// 解析常见图片格式的头部尺寸（PNG / JPEG / GIF / WebP），无额外依赖。
// 上游对首尾帧/参考图有最小尺寸要求（宽高均 ≥300px），创建任务前先拦一次。
function imageSizeOf(buf: Buffer): { width: number; height: number } | null {
  // PNG：IHDR 宽高（大端）
  if (buf.length >= 24 && buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF：逻辑屏宽高（小端）
  if (buf.length >= 10 && buf.subarray(0, 3).toString("ascii") === "GIF") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WebP：三种子格式（扩展 / 有损 / 无损）
  if (
    buf.length >= 30 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    const kind = buf.subarray(12, 16).toString("ascii");
    if (kind === "VP8X") {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    if (kind === "VP8 ") {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (kind === "VP8L") {
      const b0 = buf[21];
      const b1 = buf[22];
      const b2 = buf[23];
      const b3 = buf[24];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6)),
      };
    }
  }
  // JPEG：扫描 SOF 段（渐进式 c2 等也覆盖）
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      // 无长度的标记（SOI/EOI/RSTn）直接跳过
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2 || i + 2 + len > buf.length) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** 上游（火山方舟）要求首尾帧 / 参考图宽高都不小于 300px */
export const MIN_VIDEO_INPUT_IMAGE_SIDE = 300;

/** 从图片字节读宽高（单测入口）；解析失败返回 null */
export function imageSizeFromBuffer(buf: Buffer): { width: number; height: number } | null {
  return imageSizeOf(buf);
}

/** 读取图片宽高；解析失败返回 null（调用方按「无法读取尺寸」处理，不默认放过） */
export async function imageDimensions(url: string): Promise<{ width: number; height: number } | null> {
  const abs = await assertFile(url);
  return imageSizeOf(await readFile(abs));
}

/** 首尾帧 / 参考图最小尺寸校验：读不到尺寸也单独报错，不静默放过 */
export async function assertImageMinSide(url: string, min = MIN_VIDEO_INPUT_IMAGE_SIDE): Promise<void> {
  const dims = await imageDimensions(url);
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    throw new FirstFrameError("image_size_unreadable", "无法读取图片尺寸，请重新导出为 JPG / PNG 后再上传");
  }
  if (dims.width < min || dims.height < min) {
    throw new FirstFrameError(
      "image_too_small",
      `图片宽高都不能小于 ${min}px（当前 ${dims.width}×${dims.height}）`
    );
  }
}

/** 按首帧实际宽高选择最接近的支持比例：不裁剪图片，让生成比例跟随首帧。 */
export function nearestVideoRatio(width: number, height: number): VideoRatioName {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "9:16";
  const r = width / height;
  const candidates: [VideoRatioName, number][] = [
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["1:1", 1],
  ];
  let best = candidates[0];
  for (const c of candidates) {
    if (Math.abs(Math.log(r / c[1])) < Math.abs(Math.log(r / best[1]))) best = c;
  }
  return best[0];
}

/** 读取首帧尺寸并给出比例；无法解析时返回 null（调用方保留请求里的比例）。 */
export async function firstFrameRatio(url: string): Promise<VideoRatioName | null> {
  const abs = await assertFile(url);
  const bytes = await readFile(abs);
  const dims = imageSizeOf(bytes);
  return dims ? nearestVideoRatio(dims.width, dims.height) : null;
}
