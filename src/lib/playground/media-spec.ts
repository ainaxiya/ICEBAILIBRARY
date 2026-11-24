// ─── 实验场媒体参数规格：分辨率 × 画面比例 → 上游 size ───
// 规则（可解释，不是逐条写死）：
//   以「短边」为基准，1080 / 2K / 4K 分别对应短边 1080 / 1440 / 2160 px，
//   长边 = 短边 × 比例，四舍五入到偶数（避免部分上游要求偶数边长）。
//   于是 16:9 得到 1920×1080(FHD) / 2560×1440(QHD) / 3840×2160(UHD)，
//   2K、4K 采用行业口径（QHD / UHD），不采用相机口径（长边 2048 / 4096），
//   与界面上「1080 / 2K / 4K」的措辞保持一致。
//
// 能力门禁：模型库 capabilities 未声明尺寸能力时，只放行「已实测」的档位，
// 未实测档位在界面上直接禁用（避免发出去才失败）。实测证据见方案 §13 D22。

export const IMAGE_RESOLUTIONS = ["1080", "2K", "4K"] as const;
export const IMAGE_RATIOS = ["16:9", "9:16", "4:3", "3:4", "1:1"] as const;
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number];
export type ImageRatio = (typeof IMAGE_RATIOS)[number];

export const VIDEO_RESOLUTIONS = ["720p", "1080p"] as const;
export const VIDEO_RATIOS = ["16:9", "9:16", "1:1"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];
export type VideoRatio = (typeof VIDEO_RATIOS)[number];

const IMAGE_SHORT_EDGE: Record<ImageResolution, number> = {
  "1080": 1080,
  "2K": 1440,
  "4K": 2160,
};

const VIDEO_SHORT_EDGE: Record<VideoResolution, number> = {
  "720p": 720,
  "1080p": 1080,
};

const RATIO_WH: Record<string, [number, number]> = {
  "16:9": [16, 9],
  "9:16": [9, 16],
  "4:3": [4, 3],
  "3:4": [3, 4],
  "1:1": [1, 1],
};

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

// 短边定档、长边按比例推导，返回 "WxH"
function sizeOf(shortEdge: number, ratio: string): string {
  const [w, h] = RATIO_WH[ratio] ?? [1, 1];
  if (w === h) return `${even(shortEdge)}x${even(shortEdge)}`;
  const long = even((shortEdge * Math.max(w, h)) / Math.min(w, h));
  return w > h ? `${long}x${even(shortEdge)}` : `${even(shortEdge)}x${long}`;
}

export function imageSize(resolution: ImageResolution, ratio: ImageRatio): string {
  return sizeOf(IMAGE_SHORT_EDGE[resolution], ratio);
}

export function videoSize(resolution: VideoResolution, ratio: VideoRatio): string {
  return sizeOf(VIDEO_SHORT_EDGE[resolution], ratio);
}

// 通用视频尺寸：按模型库声明的分辨率（480p/720p/768p/1080p/2k/4k）与任意比例推导，
// 用于非 Ark 上游（miniMax 等）的 size 字段；未辨认的档位返回 null，由调用方明确拒绝。
const SHORT_EDGE_ANY: Record<string, number> = {
  "360p": 360,
  "480p": 480,
  "540p": 540,
  "720p": 720,
  "768p": 768,
  "1080p": 1080,
  "2k": 1440,
  "4k": 2160,
};

export function videoSizeFor(resolution: string, ratio: string): string | null {
  const key = resolution.trim().toLowerCase();
  const shortEdge = SHORT_EDGE_ANY[key];
  if (!shortEdge) return null;
  const [w, h] = ratio.split(":").map((n) => Number(n.trim()));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  if (w === h) return `${even(shortEdge)}x${even(shortEdge)}`;
  const long = even((shortEdge * Math.max(w, h)) / Math.min(w, h));
  return w > h ? `${long}x${even(shortEdge)}` : `${even(shortEdge)}x${long}`;
}

export interface ImageSpec {
  resolutions: ImageResolution[];
  ratios: ImageRatio[];
  /** 界面上的能力说明（为什么某些档位被收起） */
  note?: string;
}

// 已实测「按传入 size 原样出图」的模型。
// gpt-image-2（冰山聚合AI）：实测 1920×1080 / 1080×1920 / 2560×1440 / 3840×2160
//   四档均 200 且产物尺寸与请求完全一致，故 1080/2K/4K × 五种比例全部放行。
const VERIFIED_FULL_SIZE = new Set<string>(["gpt-image-2"]);

const ALL_IMAGE_RESOLUTIONS = [...IMAGE_RESOLUTIONS];
const ALL_IMAGE_RATIOS = [...IMAGE_RATIOS];

// 图片能力：命中实测表的模型放开全部档位；未实测的模型只放 1080 档，
// 2K/4K 在界面禁用并说明原因（而不是发出去等上游报错）。
export function imageSpecFor(modelName: string): ImageSpec {
  if (VERIFIED_FULL_SIZE.has(modelName)) {
    return { resolutions: ALL_IMAGE_RESOLUTIONS, ratios: ALL_IMAGE_RATIOS };
  }
  return {
    resolutions: ["1080"],
    ratios: ALL_IMAGE_RATIOS,
    note: "该模型只实测过 1080 档，2K/4K 未验证，已收起以免生成失败。",
  };
}

export function isImageResolution(v: string): v is ImageResolution {
  return (IMAGE_RESOLUTIONS as readonly string[]).includes(v);
}

export function isImageRatio(v: string): v is ImageRatio {
  return (IMAGE_RATIOS as readonly string[]).includes(v);
}

export function isVideoResolution(v: string): v is VideoResolution {
  return (VIDEO_RESOLUTIONS as readonly string[]).includes(v);
}

export function isVideoRatio(v: string): v is VideoRatio {
  return (VIDEO_RATIOS as readonly string[]).includes(v);
}
