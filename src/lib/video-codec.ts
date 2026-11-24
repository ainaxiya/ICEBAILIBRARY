// vp5/vp1 视频处置判定（只读解析，不执行 ffmpeg）。
// 判定依据是容器（MP4/MOV 的 ftyp、WebM 的 EBML）+ 视频轨 sample entry 四字符码 +
// avcC.profile_idc + moov 是否位于 mdat 之前（faststart），不信任文件扩展名与 Content-Type。
//
// 口径（用户确认）：
// - 本来就是 H.264 8-bit 且 faststart 正常 → 原样通过，不解码、不 remux。
// - 同编码但缺 faststart → 只做 -c copy 的 remux。
// - HEVC、H.264 非 8-bit、ProRes、MPEG-4 Part 2、MP4 内的 AV1/VP8/VP9 → 转码。
// - WebM 原样通过（用户实测 iPhone Safari 可正常播放 VP9 WebM）。
// - 解析失败一律放行（fail-open），不因解析能力不足误伤正常文件。

export type VideoCodecFamily =
  | "avc"
  | "hevc"
  | "av1"
  | "vp9"
  | "vp8"
  | "mpeg4"
  | "prores"
  | "unknown";

export type VideoTrackCodec = {
  /** sample entry 四字符码，如 avc1 / hvc1 / av01 */
  codec: string;
  family: VideoCodecFamily;
  /** 仅 AVC（avc1/avc3）可读：avcC 中的 profile_idc */
  profileIdc?: number;
};

export type VideoContainer = "mp4" | "webm" | "unknown";

export type VideoSourceInfo = {
  container: VideoContainer;
  /** MP4/MOV 第一条视频轨编码；WebM / 未知容器为 null */
  codec: VideoTrackCodec | null;
  /** MP4/MOV：moov 是否在第一个 mdat 之前；无法判定（WebM / 无 mdat）为 null */
  faststart: boolean | null;
};

/** 处置动作：pass 原样落盘 / remux 仅重封装加 faststart / transcode 重编码 */
export type VideoAction = "pass" | "remux" | "transcode";

type Box = { type: string; start: number; end: number };

// 读一个 box 头；start 为 payload 起点，end 为 box 结束位置
function boxAt(buf: Buffer, off: number, end: number): Box | null {
  if (off + 8 > end) return null;
  const size32 = buf.readUInt32BE(off);
  const type = buf.toString("latin1", off + 4, off + 8);
  let size = size32;
  let header = 8;
  if (size32 === 1) {
    if (off + 16 > end) return null;
    const large = buf.readBigUInt64BE(off + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    header = 16;
  } else if (size32 === 0) {
    size = end - off;
  }
  if (size < header || off + size > end) return null;
  return { type, start: off + header, end: off + size };
}

function childBoxes(buf: Buffer, parent: Box): Box[] {
  const out: Box[] = [];
  let off = parent.start;
  while (off + 8 <= parent.end) {
    const b = boxAt(buf, off, parent.end);
    if (!b) break;
    out.push(b);
    off = b.end;
  }
  return out;
}

const FAMILY: Record<string, VideoCodecFamily> = {
  avc1: "avc",
  avc3: "avc",
  hvc1: "hevc",
  hev1: "hevc",
  av01: "av1",
  vp09: "vp9",
  vp08: "vp8",
  mp4v: "mpeg4",
  apch: "prores",
  apcn: "prores",
  ap4h: "prores",
  ap4x: "prores",
};

// 视觉 sample entry 固定 78 字节（8 字节头之后），子 box（avcC 等）从这里开始
const VISUAL_ENTRY_HEADER = 78;

// AVC 的 8-bit 4:2:0 profile：Baseline / Main / Extended / High
const AVC_8BIT_PROFILES = new Set([66, 77, 88, 100]);

function readAvcProfile(buf: Buffer, entry: Box): number | undefined {
  for (const child of childBoxes(buf, { type: entry.type, start: entry.start + VISUAL_ENTRY_HEADER, end: entry.end })) {
    if (child.type === "avcC" && child.end - child.start >= 2) return buf[child.start + 1];
  }
  // 容错：个别封装在固定字段后又加了私有扩展，按签名再找一次
  const idx = buf.indexOf("avcC", entry.start, "latin1");
  if (idx >= 0 && idx + 6 <= entry.end && buf[idx + 4] === 1) return buf[idx + 5];
  return undefined;
}

function classify(buf: Buffer, entry: Box): VideoTrackCodec {
  const family = FAMILY[entry.type] ?? "unknown";
  if (family === "avc") {
    return { codec: entry.type, family, profileIdc: readAvcProfile(buf, entry) };
  }
  return { codec: entry.type, family };
}

/** 容器判定：WebM（EBML）优先，其次 ftyp（MP4 / MOV 同族） */
export function detectVideoContainer(buf: Buffer): VideoContainer {
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return "webm";
  }
  if (buf.length >= 8 && buf.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
  return "unknown";
}

/** 读取 MP4 / MOV 第一条视频轨编码信息；找不到 moov / 视频轨 / stsd 时返回 null */
export function inspectMp4VideoCodec(buf: Buffer): VideoTrackCodec | null {
  if (buf.length < 16) return null;
  const top = childBoxes(buf, { type: "root", start: 0, end: buf.length });
  const moov = top.find((b) => b.type === "moov");
  if (!moov) return null;

  for (const trak of childBoxes(buf, moov).filter((b) => b.type === "trak")) {
    const mdia = childBoxes(buf, trak).find((b) => b.type === "mdia");
    if (!mdia) continue;
    const hdlr = childBoxes(buf, mdia).find((b) => b.type === "hdlr");
    if (!hdlr || hdlr.end - hdlr.start < 12) continue;
    if (buf.toString("latin1", hdlr.start + 8, hdlr.start + 12) !== "vide") continue;

    const minf = childBoxes(buf, mdia).find((b) => b.type === "minf");
    const stbl = minf ? childBoxes(buf, minf).find((b) => b.type === "stbl") : null;
    const stsd = stbl ? childBoxes(buf, stbl).find((b) => b.type === "stsd") : null;
    if (!stsd) continue;
    // stsd = fullbox(4) + entry_count(4) + 第一条 sample entry
    const entry = boxAt(buf, stsd.start + 8, stsd.end);
    if (!entry) continue;
    return classify(buf, entry);
  }
  return null;
}

/** faststart 判定：moov 是否出现在第一个 mdat 之前；无 moov 或无 mdat 时返回 null */
function detectFaststart(buf: Buffer): boolean | null {
  if (buf.length < 16) return null;
  const top = childBoxes(buf, { type: "root", start: 0, end: buf.length });
  let moovIdx = -1;
  let mdatIdx = -1;
  for (let i = 0; i < top.length; i++) {
    if (moovIdx < 0 && top[i].type === "moov") moovIdx = i;
    if (mdatIdx < 0 && top[i].type === "mdat") mdatIdx = i;
  }
  if (moovIdx < 0 || mdatIdx < 0) return null;
  return moovIdx < mdatIdx;
}

/** 统一解析入口：容器 + 视频编码 + faststart */
export function inspectVideoSource(buf: Buffer): VideoSourceInfo {
  const container = detectVideoContainer(buf);
  if (container !== "mp4") return { container, codec: null, faststart: null };
  return {
    container,
    codec: inspectMp4VideoCodec(buf),
    faststart: detectFaststart(buf),
  };
}

/**
 * 决定处置动作。规则见文件头口径；无法判定时一律 pass（fail-open）。
 */
export function decideVideoAction(info: VideoSourceInfo): VideoAction {
  if (info.container !== "mp4") return "pass"; // WebM 原样通过；未知容器不擅自重编码
  const codec = info.codec;
  if (!codec) return "pass"; // 无视频轨 / 解析失败

  switch (codec.family) {
    case "avc": {
      // avcC 缺失时无法判断位深，按可播放放行，避免误伤
      if (codec.profileIdc == null) return "pass";
      if (!AVC_8BIT_PROFILES.has(codec.profileIdc)) return "transcode";
      return info.faststart === false ? "remux" : "pass";
    }
    case "hevc":
    case "prores":
    case "mpeg4":
    case "av1":
    case "vp9":
    case "vp8":
      return "transcode";
    default:
      return "pass";
  }
}

/** 动作对应的中文说明（写日志 / 前端提示用） */
export function videoActionReason(info: VideoSourceInfo, action: VideoAction): string {
  if (action === "pass") return "原样通过";
  if (action === "remux") return "缺 faststart，仅重新封装";
  const codec = info.codec;
  if (!codec) return "需要转码为 H.264";
  if (codec.family === "avc") return `H.264 profile ${codec.profileIdc ?? "?"} 非 8-bit，需要转码`;
  return `${codec.codec}（${codec.family}）浏览器兼容性不足，需要转码`;
}

export type CrawlVideoPlan = { action: VideoAction; ext: string };

/**
 * 采集落盘计划：
 * - WebM → 原样落 .webm；
 * - MP4/MOV → 按编码决定 pass / remux / transcode，产物统一 .mp4；
 * - 未知容器 → 有可靠扩展名就原样落盘，否则按旧逻辑尝试 remux 成 mp4。
 */
export function planCrawlVideo(info: VideoSourceInfo, fallbackExt: string | null): CrawlVideoPlan {
  if (info.container === "webm") return { action: "pass", ext: "webm" };
  if (info.container === "mp4") return { action: decideVideoAction(info), ext: "mp4" };
  return fallbackExt ? { action: "pass", ext: fallbackExt } : { action: "remux", ext: "mp4" };
}
