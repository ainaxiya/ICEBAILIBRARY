// ─── 视频模型能力矩阵（Seedance 2.x） ───
// 数据来源：火山方舟官方文档「Doubao Seedance 2.5 系列教程」能力概述表 +
// 控制台模型详情「模型限制」。前端下拉/上传上限、服务端参数校验都读这一份，
// 不在界面里写死某一档（换模型、加档位只改这里）。
//
// 注意：2026-11 起视频计费统一为「后台填写的每秒会员价 × 秒数」，
// 不再按分辨率/含视频输入分档；前台「X 积分/秒」直接读 model_pricing 通用行。

/** 视频能力：分辨率、比例、时长、有声、参考素材上限 */
export interface VideoCapability {
  /** 时长下限（秒，整数） */
  minDuration: number;
  /** 时长上限（秒，整数；各档位连续可选） */
  maxDuration: number;
  /** 输出分辨率档位（顺序即界面顺序） */
  resolutions: string[];
  /** 输出宽高比（adaptive = 跟随输入素材） */
  ratios: string[];
  /** 是否支持有声视频（generate_audio） */
  audio: boolean;
  /** 界面是否展示「有声 / 无声」选择：模型没有该参数时不显示 */
  audioToggle: boolean;
  /** 首帧输入 */
  firstFrame: boolean;
  /** 尾帧输入 */
  lastFrame: boolean;
  /** 参考图上限（0 = 不支持） */
  maxReferenceImages: number;
  /** 参考视频上限（0 = 不支持） */
  maxReferenceVideos: number;
  /** 参考音频上限（0 = 不支持） */
  maxReferenceAudios: number;
  /** 能力说明（界面小字提示） */
  note?: string;
}

export const SEEDANCE_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"] as const;

/** 通用兜底：非 Seedance 2.x 的视频模型（参数按既有实测档位保守放行） */
const GENERIC_VIDEO: VideoCapability = {
  minDuration: 4,
  maxDuration: 10,
  resolutions: ["720p", "1080p"],
  ratios: ["16:9", "9:16", "1:1"],
  audio: false,
  audioToggle: false,
  firstFrame: true,
  lastFrame: false,
  maxReferenceImages: 0,
  maxReferenceVideos: 0,
  maxReferenceAudios: 0,
  note: "该模型未登记能力矩阵，仅放行已实测档位。",
};

// Seedance 2.5 / 2.5 flash：4–30s；flash 只有 480p/720p
const SEEDANCE_25: VideoCapability = {
  minDuration: 4,
  maxDuration: 30,
  resolutions: ["480p", "720p", "1080p", "4K"],
  ratios: [...SEEDANCE_RATIOS],
  audio: true,
  audioToggle: true,
  firstFrame: true,
  lastFrame: true,
  maxReferenceImages: 30,
  maxReferenceVideos: 10,
  maxReferenceAudios: 10,
};

const SEEDANCE_25_FLASH: VideoCapability = {
  ...SEEDANCE_25,
  resolutions: ["480p", "720p"],
  maxReferenceImages: 10,
  maxReferenceVideos: 5,
  maxReferenceAudios: 5,
};

// Seedance 2.0 系列：4–15s
const SEEDANCE_20: VideoCapability = {
  minDuration: 4,
  maxDuration: 15,
  resolutions: ["480p", "720p", "1080p", "4K"],
  ratios: [...SEEDANCE_RATIOS],
  audio: true,
  audioToggle: true,
  firstFrame: true,
  lastFrame: true,
  maxReferenceImages: 9,
  maxReferenceVideos: 3,
  maxReferenceAudios: 3,
};

const SEEDANCE_20_FAST: VideoCapability = {
  ...SEEDANCE_20,
  resolutions: ["480p", "720p"],
};

const SEEDANCE_20_MINI: VideoCapability = {
  ...SEEDANCE_20,
  resolutions: ["480p", "720p"],
};

// 判定顺序：flash 必须先于 2-5 主系列匹配，fast/mini 必须先于 2-0 主系列匹配。
// 模型名兼容两种入库口径：火山原生 `doubao-seedance-2-5-260628` 与
// 聚合渠道 `seedance-2-5-reference-to-video-basic`（无 doubao 前缀、2.0/2_0 写法）。
// ─── 模型库优先：advancedConfig.model_spec.constraints 是唯一能力来源 ───
// 前台只展示库里声明的分辨率 / 比例 / 时长 / 素材 / 有声，不再用写死矩阵兜底。
// 仅当库里没有 constraints（例如火山 Seedance 的能力文件是另一套结构）时，
// 才退回下面的 Seedance 专用矩阵，避免这些已上线模型失去参数。
function readConstraints(advancedConfig: unknown): Record<string, unknown> | null {
  let raw = advancedConfig;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const spec = (obj.model_spec ?? obj) as Record<string, unknown>;
  const constraints = spec?.constraints;
  return constraints && typeof constraints === "object"
    ? (constraints as Record<string, unknown>)
    : null;
}

function capabilityFromConstraints(modelName: string, c: Record<string, unknown>): VideoCapability {
  const durations = Array.isArray(c.durations)
    ? c.durations
        .map((v) => Number.parseInt(String(v), 10))
        .filter((n) => Number.isInteger(n) && n > 0)
    : [];
  const resolutions = Array.isArray(c.resolutions)
    ? c.resolutions.map((v) => normalizeVideoResolution(String(v))).filter(Boolean)
    : [];
  const ratios = Array.isArray(c.aspect_ratios)
    ? c.aspect_ratios.map((v) => String(v)).filter(Boolean)
    : [];
  const audio = c.audio === true;
  // minimax-h3 系列没有「有声 / 无声」开关：固定有声，界面不出现选择框
  const minimaxH3 = /^minimax-h3/i.test(modelName);
  return {
    minDuration: durations.length ? Math.min(...durations) : 4,
    maxDuration: durations.length ? Math.max(...durations) : 15,
    resolutions,
    ratios,
    audio,
    audioToggle: audio && c.audio_configurable === true && !minimaxH3,
    firstFrame: c.image_input === true,
    lastFrame: c.end_image_input === true,
    maxReferenceImages: c.reference_images === true ? 3 : 0,
    maxReferenceVideos: c.video_input === true ? 1 : 0,
    maxReferenceAudios: 0,
  };
}

export function videoCapabilityFor(modelName: string, advancedConfig?: unknown): VideoCapability {
  const constraints = readConstraints(advancedConfig);
  if (constraints) return capabilityFromConstraints(modelName, constraints);
  const name = modelName.toLowerCase().replace(/^doubao-/, "").replace(/[._]/g, "-");
  if (/^seedance-2-5-flash/.test(name)) return SEEDANCE_25_FLASH;
  if (/^seedance-2-5/.test(name)) return SEEDANCE_25;
  if (/^seedance-2-0-fast/.test(name)) return SEEDANCE_20_FAST;
  if (/^seedance-2-0-mini/.test(name)) return SEEDANCE_20_MINI;
  if (/^seedance-2-0/.test(name)) return SEEDANCE_20;
  return GENERIC_VIDEO;
}

/** 分辨率归一：4k → 4K（与 model_pricing.variant 口径一致） */
export function normalizeVideoResolution(raw: string): string {
  return /^4k$/i.test(raw.trim()) ? "4K" : raw.trim().toLowerCase();
}

/** 时长候选：全数字可选（4、5、6 … max），不做档位跳选 */
export function durationOptions(cap: VideoCapability): number[] {
  const out: number[] = [];
  for (let s = cap.minDuration; s <= cap.maxDuration; s++) out.push(s);
  return out;
}

/** 比例文案（沿用站内中文，不出现英文标签） */
export const RATIO_LABEL: Record<string, string> = {
  "21:9": "21:9 超宽",
  "16:9": "16:9 横屏",
  "4:3": "4:3 横屏",
  "1:1": "1:1 方形",
  "3:4": "3:4 竖版",
  "9:16": "9:16 竖屏",
  adaptive: "自适应（跟随素材）",
};
