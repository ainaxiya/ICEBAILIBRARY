// 全站上传产物的「类型枚举 + 扩展名映射 + 命名 + 月份目录」单一来源。
// 落盘命名（upload-store.server.ts）、对象存储 objectKey、各上传入口的扩展名判定
// 都读这里同一张表，禁止在别处再写一份映射。
import crypto from "node:crypto";

export const UPLOAD_KINDS = [
  "image",
  "video",
  "audio",
  "txt",
  "pdf",
  "zip",
  "exe",
  "doc",
  "other",
] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

// 扩展名 → 类型名（不含点、全小写）。未命中的一律落 other，不因判不出而拒收。
export const KIND_EXTENSIONS: Readonly<Record<UploadKind, readonly string[]>> = {
  image: ["jpg", "jpeg", "png", "webp", "gif", "avif", "svg"],
  video: ["mp4", "webm", "mov", "m4v"],
  audio: ["mp3", "wav", "m4a", "aac", "ogg", "flac"],
  txt: ["txt", "md", "json", "csv", "srt", "log", "xml", "yaml"],
  pdf: ["pdf"],
  zip: ["zip", "7z", "rar", "tar", "gz", "bz2"],
  exe: ["exe", "msi", "apk", "dmg", "deb", "rpm"],
  doc: ["doc", "docx", "xls", "xlsx", "ppt", "pptx"],
  other: [],
};

const EXT_TO_KIND: Readonly<Record<string, UploadKind>> = (() => {
  const map: Record<string, UploadKind> = {};
  for (const kind of UPLOAD_KINDS) {
    for (const ext of KIND_EXTENSIONS[kind]) map[ext] = kind;
  }
  return Object.freeze(map);
})();

/** 规整扩展名（去点、小写）；非法字符返回空串 */
export function normalizeExt(input: string | null | undefined): string {
  const e = String(input || "")
    .toLowerCase()
    .replace(/^\./, "");
  return /^[a-z0-9]{1,8}$/.test(e) ? e : "";
}

/** 从文件名取扩展名（不含点、小写） */
export function extOfFileName(name: string | null | undefined): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}

/** 扩展名 → 类型名；判不出来落 other */
export function kindForExt(ext: string | null | undefined): UploadKind {
  return EXT_TO_KIND[normalizeExt(ext)] ?? "other";
}

export function kindForFileName(name: string | null | undefined): UploadKind {
  return kindForExt(extOfFileName(name));
}

/** 是否在映射表内（能判定出具体类型，不含 other 兜底）；供上传白名单校验复用 */
export function isKnownExt(ext: string | null | undefined): boolean {
  return EXT_TO_KIND[normalizeExt(ext)] !== undefined;
}

/** 该类型名允许的扩展名列表 */
export function extensionsOf(kind: UploadKind): readonly string[] {
  return KIND_EXTENSIONS[kind];
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 真随机字母数字串（crypto.randomInt，无取模偏差） */
export function randomAlnum(len = 12): string {
  let out = "";
  for (let i = 0; i < len; i++) out += ALNUM[crypto.randomInt(ALNUM.length)];
  return out;
}

/** 文件名 = 类型名-时间刻度-随机12位.扩展名 */
export function makeUploadName(kind: UploadKind, ext: string, at: number = Date.now()): string {
  const e = normalizeExt(ext);
  return `${kind}-${at}-${randomAlnum(12)}${e ? "." + e : ""}`;
}

/** 月份目录 YYYY-MM（服务器本地时间固定按 Asia/Shanghai 计算） */
export function uploadMonth(now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
    }).formatToParts(now);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    if (y && m) return `${y}-${m}`;
  } catch {
    /* 运行时缺 Intl 时回退本地时间 */
  }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
