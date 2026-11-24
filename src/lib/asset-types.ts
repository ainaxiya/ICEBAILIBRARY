// 资产分类的唯一口径：DB 里 assetType 是字符串（历史值只读不改写），
// 这里集中维护取值、中文名与图标，生成/上传/会员资产列表/后台展示保持一致。
export const ASSET_TYPES = [
  "image",
  "video",
  "audio",
  "speech",
  "music",
  "sfx",
  "model3d",
  "text",
  "document",
  "archive",
  "other",
  // 历史值：P5 早期产物用 file 表示未细分类型，保留可读
  "file",
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];

const TYPE_LABEL: Record<AssetType, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  speech: "语音",
  music: "音乐",
  sfx: "音效",
  model3d: "3D 模型",
  text: "文本",
  document: "文档",
  archive: "压缩包",
  other: "其他",
  file: "文件",
};

const TYPE_ICON: Record<AssetType, string> = {
  image: "🖼️",
  video: "🎬",
  audio: "🎵",
  speech: "🗣️",
  music: "🎼",
  sfx: "🔊",
  model3d: "🧊",
  text: "📝",
  document: "📑",
  archive: "🗜️",
  other: "📄",
  file: "📄",
};

export function assetTypeLabel(t: string): string {
  return TYPE_LABEL[t as AssetType] ?? t;
}

export function assetTypeIcon(t: string): string {
  return TYPE_ICON[t as AssetType] ?? "📄";
}

// 真实 MIME → 资产分类（只用于“未细分的通用类型”升级，不覆盖调用方明确给定的 image/video/speech 等）
export function assetTypeFromMime(mime: string | null | undefined): AssetType | null {
  if (!mime) return null;
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m === "model/gltf-binary" || m === "model/gltf+json" || m === "model/obj" || m === "application/x-fbx") {
    return "model3d";
  }
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "document";
  if (
    m === "application/zip" ||
    m === "application/gzip" ||
    m === "application/x-7z-compressed" ||
    m === "application/vnd.rar"
  ) {
    return "archive";
  }
  if (m.startsWith("text/")) return "text";
  return null;
}

// 调用方只给了笼统 file（历史口径）时，按真实 MIME 升级到具体分类；明确分类保持不变
export function refineAssetType(declared: AssetType, mime: string | null): AssetType {
  if (declared !== "file") return declared;
  return assetTypeFromMime(mime) ?? "file";
}
