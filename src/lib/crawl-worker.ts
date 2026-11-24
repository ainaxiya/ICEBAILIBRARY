// 采集入库后台任务执行器（在 Next 进程内异步运行，PM2 常驻期间可靠；进度落 CrawlJob 表）
import {
  mkdirSync,
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  rmSync,
  createWriteStream,
  renameSync,
} from "node:fs";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";

import { db } from "./db";
import { syncPromptToMeili } from "./meili";
import { saveUploadSync, commitUploadFromTemp, uploadUrlToPath } from "./upload-store.server";
import {
  LIBTV_HEADERS,
  fetchLibtvDetail,
  buildWorkPayload,
  type MediaPlanItem,
} from "./crawl-libtv";
import {
  JIMENG_HEADERS,
  buildJimengPayload,
  type JimengFeedItem,
  type MediaPlanItem as JimengMediaPlanItem,
} from "./crawl-jimeng";
import { resolveCoverSources } from "./crawl-cover";
import { inspectVideoSource, planCrawlVideo } from "./video-codec";
import { transcodeVideoFile } from "./video-transcode.server";
import { tmpPath } from "./tmp-dir.server";

const execFileP = promisify(execFile);
// 生产机 apt 安装在 /usr/bin/ffmpeg；可用环境变量覆盖
const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_PATH || "ffprobe";

// 采集去重清单：源地址 → 已落盘文件。落盘改为随机名后，靠清单复用同一份文件，
// 同一作品重复采集不会再产生重复视频/图片。清单按作品（source + remoteId）分文件，
// 写入用 临时文件 + rename 原子替换。
const CRAWL_META_ROOT = path.join(process.cwd(), "public", "uploads", ".crawl-meta");
type ManifestEntry = { url: string; type: "image" | "video" };
type Manifest = Record<string, ManifestEntry>;

function manifestFile(source: string, remoteId: string): string {
  const key = crypto.createHash("sha1").update(`${source}:${remoteId}`).digest("hex").slice(0, 20);
  return path.join(CRAWL_META_ROOT, `${source}-${key}.json`);
}

function readManifest(file: string): Manifest {
  try {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, "utf8")) as Manifest;
  } catch {
    return {};
  }
}

function writeManifest(file: string, data: Manifest): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file);
  } catch (e) {
    console.warn(`[crawl] 去重清单写入失败 ${file}:`, (e as any)?.message || e);
  }
}

// 清单命中且文件仍存在 → 直接复用，不重复下载/落盘
function reuseUpload(manifest: Manifest, key: string, type: "image" | "video"): string | null {
  const entry = manifest[key];
  if (!entry || entry.type !== type) return null;
  const abs = uploadUrlToPath(entry.url);
  if (!abs || !existsSync(abs) || statSync(abs).size === 0) return null;
  return entry.url;
}

// ─── 视频本地化限额（可用环境变量调整） ───
// 大小上限：单条视频超过则退化为「仅保留截帧」，并在前台标注原因
const VIDEO_MAX_MB = Math.max(1, Number(process.env.CRAWL_VIDEO_MAX_MB) || 60);
const VIDEO_MAX_BYTES = VIDEO_MAX_MB * 1024 * 1024;
// 时长上限（秒）：超过同样只留截帧；ffprobe 不可用时跳过时长校验
const VIDEO_MAX_SECONDS = Math.max(1, Number(process.env.CRAWL_VIDEO_MAX_SECONDS) || 60);
// 视频体积大，单次请求超时较图片放宽；重试次数沿用 fetchRemoteBuf 的 3 次
const VIDEO_TIMEOUT_MS = Math.max(10_000, Number(process.env.CRAWL_VIDEO_TIMEOUT_MS) || 120_000);

// 体积/时长超限：不重试，按降级处理
class VideoDegradeError extends Error {}

// 环境类错误（临时目录不可写/磁盘满/只读）与上游失败区分开：
// 前者需要在任务/条目上留告警，不能静默当成功。
function isEnvError(e: unknown): boolean {
  const code = String((e as any)?.code || "");
  const text = `${(e as any)?.message || ""} ${(e as any)?.stderr || ""}` || String(e);
  return (
    /^(EACCES|EPERM|ENOSPC|EROFS|EDQUOT)$/.test(code) ||
    /EACCES|EPERM|ENOSPC|EROFS|EDQUOT|Permission denied|Read-only file system|No space left/i.test(text)
  );
}

function envErrorText(e: unknown): string {
  return String((e as any)?.message || e).slice(0, 160);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// importFn 查表：libtv/jimeng 走 Prompt 表
type ImportFn = (itemId: number, importerId: number, adminId: number) => Promise<{ skipped?: boolean; [k: string]: any }>;
const IMPORT_FNS: Record<string, ImportFn> = {
  libtv: importLibtvItem,
  jimeng: importJimengItem,
};

// 根据数据源选择请求头
function headersFor(source: string) {
  if (source === "jimeng") return JIMENG_HEADERS;
  return LIBTV_HEADERS;
}

async function fetchRemoteBuf(url: string, source = "libtv", retry = 3): Promise<Buffer> {
  const h = headersFor(source);
  for (let i = 0; i < retry; i++) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": h["User-Agent"], Referer: h.Referer, Origin: (h as any).Origin || h.Referer },
        signal: AbortSignal.timeout(45000),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i === retry - 1) throw e;
      await sleep(1200 * (i + 1));
    }
  }
  throw new Error("unreachable");
}

const IMPORTERS: Record<string, { name: string; nickname: string; bio: string }> = {
  libtv: { username: "libtv" } as any,
  jimeng: { username: "jimeng" } as any,
};

async function ensureImporter(source: string) {
  const username = source === "jimeng" ? "jimeng" : "libtv";
  const nickname = source === "jimeng" ? "即梦AI 采集" : "LibTV 采集";
  const bio = source === "jimeng"
    ? "即梦AI 创作灵感社区自动采集账号"
    : "LibLib TV 官方作品自动采集账号";
  return db.user.upsert({
    where: { username },
    update: {},
    create: { username, nickname, bio, membershipLevel: "importer" },
  });
}

// 下载并 webp 化单张图片，返回 webp 字节；失败返回 null
async function fetchImageWebp(url: string, source = "libtv"): Promise<Buffer | null> {
  try {
    const buf = await fetchRemoteBuf(url, source);
    return await sharp(buf, { failOn: "none" })
      .rotate()
      .resize({ width: 1280, height: 1920, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
  } catch {
    return null;
  }
}

// 远程视频截帧：多个时间点尝试（规避片头黑场淡入），取平均亮度最高的一帧，webp 化
// 移植自 scripts/liblib-import-media.mjs（ffmpeg 走 PATH，-referer 带防盗链）
type FrameShot = { buf: Buffer | null; envError?: string };

async function screenshotVideo(url: string, source = "libtv"): Promise<FrameShot> {
  const h = headersFor(source);
  const tries = ["1", "3", "0.5"];
  let best: { mean: number; buf: Buffer } | null = null;
  let envError: string | undefined;
  for (const ss of tries) {
    let tmp: string;
    try {
      tmp = tmpPath(`crawl-frame-${process.pid}-${crypto.randomBytes(6).toString("hex")}.jpg`);
    } catch (e) {
      // 临时目录本身不可用，继续尝试也没有意义
      return { buf: null, envError: envErrorText(e) };
    }
    try {
      await execFileP(
        FFMPEG_BIN,
        [
          "-nostdin",
          "-loglevel",
          "error",
          "-y",
          "-ss",
          ss,
          "-referer",
          h.Referer,
          "-user_agent",
          h["User-Agent"],
          "-i",
          url,
          "-frames:v",
          "1",
          "-q:v",
          "4",
          "-vf",
          "scale=min(1280\\,iw):-2",
          tmp,
        ],
        { timeout: 90000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }
      );
      const buf = readFileSync(tmp);
      const st = await sharp(buf, { failOn: "none" }).grayscale().stats();
      if (!best || st.channels[0].mean > best.mean) best = { mean: st.channels[0].mean, buf };
      if (st.channels[0].mean >= 22) break; // 已足够亮，不再尝试更早点位
    } catch (e) {
      if (!envError && isEnvError(e)) envError = envErrorText(e);
      /* 单个时间点失败则尝试下一个 */
    } finally {
      safeRm(tmp);
    }
  }
  if (!best) return { buf: null, envError };
  try {
    return {
      buf: await sharp(best.buf, { failOn: "none" })
        .rotate()
        .resize({ width: 1280, height: 1920, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer(),
      envError,
    };
  } catch {
    return { buf: null, envError };
  }
}

// 视频本地化：先下到项目内临时目录（tmp/），成功后原子移动到 uploads/<YYYY-MM>/video-...
// 去重由去重清单负责（见 reuseUpload），不再用源地址 hash 做文件名。
// 【存储口径】采集链路（LIBTV 等）产物永远只落本地 public/uploads/，忽略默认桶设置：
// 桶按流量计费，采集是批量搬图片/视频，最费带宽；「用户主动上传可进默认桶」是另一套口径，
// 见 src/lib/upload-core.server.ts 的 saveUserMedia。此处禁止改为走桶上传。
export interface VideoDownloadResult {
  ok: boolean;
  url?: string;
  reason?: string; // ok=false 时的中文原因，用于前台标注
  /** 环境类失败（临时目录不可写/磁盘满等），需在任务/条目上留告警 */
  envError?: boolean;
  /** 转码失败但原文件已保留（不入作品媒体，前台退回截帧） */
  transcodeFailed?: boolean;
  /** 转码失败时保留下来的原文件地址（备查） */
  rawUrl?: string;
}

const VIDEO_EXTS = ["mp4", "webm"];

// Windows 上半关闭的句柄可能让删除失败，清理失败不影响主流程
function safeRm(file: string) {
  try {
    rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}

function extFromContentType(ct: string | null): string | null {
  const t = (ct || "").split(";")[0].trim().toLowerCase();
  if (t === "video/mp4") return "mp4";
  if (t === "video/webm") return "webm";
  return null;
}

async function probeDurationSec(file: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP(
      FFPROBE_BIN,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
      { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true }
    );
    const d = parseFloat(String(stdout).trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null; // ffprobe 缺失/文件异常：跳过时长校验，不阻断入库
  }
}

// 下载一次到 tmp（流式，超限立即中断），返回 content-type
async function downloadOnce(url: string, tmp: string, source: string): Promise<string | null> {
  const h = headersFor(source);
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), VIDEO_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": h["User-Agent"], Referer: h.Referer, Origin: (h as any).Origin || h.Referer },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const declared = Number(r.headers.get("content-length") || 0);
    if (declared > VIDEO_MAX_BYTES) {
      throw new VideoDegradeError(`原视频 ${(declared / 1024 / 1024).toFixed(1)}MB 超过 ${VIDEO_MAX_MB}MB 上限`);
    }
    if (!r.body) throw new Error("响应无内容");
    let total = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        total += chunk.length;
        if (total > VIDEO_MAX_BYTES) {
          cb(new VideoDegradeError(`原视频超过 ${VIDEO_MAX_MB}MB 上限`));
          return;
        }
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(r.body as any), limiter, createWriteStream(tmp));
    return r.headers.get("content-type");
  } finally {
    clearTimeout(tm);
  }
}

async function downloadVideo(url: string, source = "libtv"): Promise<VideoDownloadResult> {
  let tmp: string;
  try {
    tmp = tmpPath(`crawl-video-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  } catch (e) {
    return { ok: false, envError: true, reason: `临时目录不可用（${envErrorText(e)}），仅展示截图` };
  }
  let contentType: string | null = null;
  try {
    const retry = 3;
    for (let i = 0; i < retry; i++) {
      try {
        contentType = await downloadOnce(url, tmp, source);
        break;
      } catch (e) {
        safeRm(tmp);
        if (e instanceof VideoDegradeError) return { ok: false, reason: e.message + "，仅展示截图" };
        if (isEnvError(e)) {
          return { ok: false, envError: true, reason: `原视频下载失败（${envErrorText(e)}），仅展示截图` };
        }
        if (i === retry - 1) return { ok: false, reason: `原视频下载失败（${String((e as any)?.message || e).slice(0, 80)}），仅展示截图` };
        await sleep(1500 * (i + 1));
      }
    }

    const dur = await probeDurationSec(tmp);
    if (dur != null && dur > VIDEO_MAX_SECONDS) {
      safeRm(tmp);
      return { ok: false, reason: `原视频时长 ${Math.round(dur)}s 超过 ${VIDEO_MAX_SECONDS}s 上限，仅展示截图` };
    }

    // vp1：按内容判定处置动作，不按扩展名一刀切。
    // 本来就是 H.264 8-bit + faststart / WebM → 原样落盘；缺 faststart 只 remux；
    // HEVC、非 8-bit H.264、ProRes、mp4v、MP4 内 AV1/VP9 → 转码成 H.264 8-bit。
    const urlExt = path.extname(new URL(url).pathname).slice(1).toLowerCase();
    const fallbackExt = extFromContentType(contentType) || (VIDEO_EXTS.includes(urlExt) ? urlExt : null);
    const plan = planCrawlVideo(inspectVideoSource(readFileSync(tmp)), fallbackExt);

    if (plan.action === "pass") {
      const saved = await commitUploadFromTemp(tmp, "video", plan.ext);
      return { ok: true, url: saved.url };
    }

    let outPath: string | null = null;
    try {
      outPath = await transcodeVideoFile(plan.action, tmp);
      safeRm(tmp);
      const saved = await commitUploadFromTemp(outPath, "video", "mp4");
      return { ok: true, url: saved.url };
    } catch (e) {
      if (outPath) safeRm(outPath);
      // 兜底（与用户上传相反）：转码失败不丢原文件 —— 原样落盘备查，
      // 但 video 不进作品媒体（不入库），前台退回截帧并标注原因。
      const label = plan.action === "remux" ? "重新封装" : "转码";
      try {
        const kept = await commitUploadFromTemp(tmp, "video", plan.ext);
        return {
          ok: false,
          transcodeFailed: true,
          rawUrl: kept.url,
          reason: `原视频${label}失败，已保留原文件，仅展示截图`,
        };
      } catch {
        safeRm(tmp);
        return { ok: false, transcodeFailed: true, reason: `原视频${label}失败，仅展示截图` };
      }
    }
  } catch (e) {
    safeRm(tmp);
    return {
      ok: false,
      envError: isEnvError(e),
      reason: `原视频本地化异常（${String((e as any)?.message || e).slice(0, 80)}），仅展示截图`,
    };
  }
}

// ─── LIBTV 单条入库 ───
async function importLibtvItem(itemId: number, importerId: number, adminId: number) {
  const item = await db.crawlItem.findUnique({ where: { id: itemId } });
  if (!item || item.status === "collected") return { skipped: true };
  if (!item.templateUuid) throw new Error("缺少 templateUuid");

  const detail = await fetchLibtvDetail(item.templateUuid);
  const payload = buildWorkPayload(detail);
  if (!payload.content.trim()) throw new Error("作品快照中没有可采集的节点");

  const sourceUrl = `https://www.liblib.tv/canvas?sourceProjectUuid=${item.remoteId}`;
  const prompt = await db.prompt.create({
    data: {
      userId: importerId,
      title: item.title,
      content: payload.content,
      type: payload.type,
      category: payload.category,
      language: "zh",
      tags: item.tags,
      sourceSite: "liblib.tv",
      sourceAuthor: item.author,
      sourceUrl,
      likeCount: item.likeCount,
      status: "published",
      publishedAt: item.remoteCreatedAt ?? null,
      adminAuthorId: adminId,
    },
  });

  const manifestPath = manifestFile("libtv", item.remoteId);
  const manifest = readManifest(manifestPath);
  const media: any[] = [];
  let coverUrl: string | null = null;
  if (payload.coverUrl) {
    let url = reuseUpload(manifest, payload.coverUrl, "image");
    if (!url) {
      const buf = await fetchImageWebp(payload.coverUrl);
      if (buf) {
        const saved = saveUploadSync("image", "webp", buf);
        url = saved.url;
        manifest[payload.coverUrl] = { url, type: "image" };
      }
    }
    if (url) {
      coverUrl = url;
      media.push({
        type: "image",
        role: "cover",
        url,
        sourceUrl: payload.coverUrl,
        alt: item.title,
      });
    }
  }
  // 先下载图片与视频截帧，再本地化视频本体；视频失败时回退为截帧并标注原因
  type NodeSlot =
    | { kind: "image"; item: any }
    | { kind: "video"; plan: MediaPlanItem; frameUrl?: string; result?: any; degradeReason?: string };
  const slots: NodeSlot[] = [];
  let imgOk = 0;
  let frameOk = 0;
  let envWarning = "";
  for (const m of payload.mediaPlan as MediaPlanItem[]) {
    if (m.kind === "video") {
      const frameKey = `${m.url}#frame`;
      let frameUrl = reuseUpload(manifest, frameKey, "image");
      if (frameUrl) {
        frameOk++;
      } else {
        const shot = await screenshotVideo(m.url);
        if (shot.buf) {
          const saved = saveUploadSync("image", "webp", shot.buf);
          frameUrl = saved.url;
          manifest[frameKey] = { url: frameUrl, type: "image" };
          frameOk++;
        } else if (shot.envError && !envWarning) {
          envWarning = `截帧失败：${shot.envError}`;
        }
      }
      slots.push({ kind: "video", plan: m, frameUrl: frameUrl || undefined });
    } else {
      let url = reuseUpload(manifest, m.url, "image");
      if (!url) {
        const buf = await fetchImageWebp(m.url);
        if (!buf) continue;
        const saved = saveUploadSync("image", "webp", buf);
        url = saved.url;
        manifest[m.url] = { url, type: "image" };
      }
      imgOk++;
      slots.push({
        kind: "image",
        item: {
          type: "image",
          role: "node",
          url,
          section: m.section,
          nodeKind: m.kind,
          sourceUrl: m.url,
          alt: m.alt,
        },
      });
    }
    await sleep(80);
  }

  let videoOk = 0;
  let videoDegraded = 0;
  for (const slot of slots) {
    if (slot.kind !== "video") continue;
    let videoUrl = reuseUpload(manifest, slot.plan.url, "video");
    if (videoUrl) {
      videoOk++;
    } else {
      const res = await downloadVideo(slot.plan.url);
      if (res.ok && res.url) {
        videoUrl = res.url;
        manifest[slot.plan.url] = { url: videoUrl, type: "video" };
        videoOk++;
      } else {
        videoDegraded++;
        slot.degradeReason = res.reason || "原视频未能本地化，仅展示截图";
        if (res.envError && !envWarning) envWarning = `视频下载失败：${envErrorText(res.reason)}`;
        console.warn(`[crawl] 视频本地化降级 prompt=${prompt.id} url=${slot.plan.url.slice(0, 120)} reason=${res.reason || "未知"}`);
        if (slot.frameUrl) {
          slot.result = {
            type: "image",
            role: "node",
            url: slot.frameUrl,
            section: slot.plan.section,
            nodeKind: "video",
            sourceUrl: slot.plan.url,
            alt: slot.plan.alt,
            note: res.reason || "原视频未能本地化，仅展示截图",
            // 转码失败标记：原文件已保留在 rawUrl，视频本体不入作品媒体
            ...(res.transcodeFailed ? { transcodeFailed: true, rawUrl: res.rawUrl } : {}),
          };
        }
      }
    }
    if (videoUrl) {
      slot.result = {
        type: "video",
        role: "node",
        url: videoUrl,
        poster: slot.frameUrl, // 封面仍用截帧
        section: slot.plan.section,
        nodeKind: "video",
        sourceUrl: slot.plan.url,
        alt: slot.plan.alt,
      };
    }
    await sleep(80);
  }
  for (const slot of slots) {
    const m = slot.kind === "image" ? slot.item : slot.result;
    if (m) media.push(m);
  }

  // 没有截帧可挂的降级视频：把原因汇总到封面（或首个媒体）的 note，避免前台无提示
  const noFrameDegraded = slots.filter((s) => s.kind === "video" && !s.result && s.degradeReason);
  if (noFrameDegraded.length > 0) {
    const reasons = Array.from(
      new Set(noFrameDegraded.map((s) => String(s.kind === "video" ? s.degradeReason : "").replace(/，仅展示截图$/, "")))
    );
    const text = `${noFrameDegraded.length} 个视频未能本地化（${reasons.join("；")}），未生成截帧`;
    const host = media.find((m) => m.role === "cover") || media[0];
    if (host) host.note = host.note ? `${host.note}；${text}` : text;
    else if (!envWarning) envWarning = text;
  }

  // 去重清单落盘（源地址 → 已落盘文件），供同一作品再次采集时复用
  writeManifest(manifestPath, manifest);

  await db.prompt.update({
    where: { id: prompt.id },
    data: { media, ...(coverUrl ? { coverUrl } : {}) },
  });
  await syncPromptToMeili({
    id: prompt.id,
    title: prompt.title,
    content: prompt.content,
    description: null,
    type: prompt.type,
    category: prompt.category,
    language: prompt.language,
    tags: prompt.tags,
    likeCount: prompt.likeCount,
    viewCount: 0,
    createdAt: prompt.createdAt,
    sourceAuthor: prompt.sourceAuthor,
    coverUrl: coverUrl,
  });

  await db.crawlItem.update({
    where: { id: item.id },
    data: {
      status: "collected",
      error: envWarning ? `[告警] ${envWarning}` : null,
      kind: payload.type,
      promptId: prompt.id,
      collectedAt: new Date(),
    },
  });
  return {
    promptId: prompt.id,
    mediaCount: media.length,
    imgOk,
    frameOk,
    videoOk,
    videoDegraded,
    coverOk: Boolean(coverUrl),
    envWarning: envWarning || undefined,
  };
}

// ─── 即梦 单条入库 ───
async function importJimengItem(itemId: number, importerId: number, adminId: number) {
  const item = await db.crawlItem.findUnique({ where: { id: itemId } });
  if (!item || item.status === "collected") return { skipped: true };

  // 即梦数据已在 fetch 阶段存好（title/coverUrl/tags/likeCount），直接用 CrawlItem 构建
  // tags 约定（新）：tags[0] 为 "__meta__" 前缀 JSON（p=提示词 m=模型名 w=形态 v=视频地址 i=大图地址 c=远端封面），其余为真实标签
  // 兼容旧格式：[0] 提示词  [1] 模型名  [2] 形态  [3] 视频地址
  const META_PREFIX = "__meta__";
  let meta: { p?: string; m?: string; w?: string; v?: string; i?: string; c?: string } = {};
  const realTags: string[] = [];
  for (const t of item.tags) {
    if (t.startsWith(META_PREFIX)) {
      try {
        meta = JSON.parse(t.slice(META_PREFIX.length));
      } catch {
        /* 忽略损坏的 meta */
      }
    } else {
      realTags.push(t);
    }
  }
  const isOldFormat = !item.tags.some((t) => t.startsWith(META_PREFIX));
  const promptText = isOldFormat ? item.tags[0] || "" : meta.p || "";
  const modelName = isOldFormat ? item.tags[1] || "" : meta.m || "";
  const workType: "image" | "video" = isOldFormat
    ? item.tags[2] === "video"
      ? "video"
      : "image"
    : meta.w === "video"
      ? "video"
      : "image";
  const videoUrl = workType === "video" ? (isOldFormat ? item.tags[3] || null : meta.v || null) : null;
  const finalTags = isOldFormat ? item.tags.filter((_, i) => i >= 4) : realTags;
  // 封面来源：远端签名地址（meta.c）优先；fetch 阶段已缓存的本地封面作为兜底（远端过期时不再丢图）
  const { remote: remoteCover, cached: cachedCover } = resolveCoverSources(item.coverUrl, isOldFormat ? null : meta.c);

  const jimengItem: JimengFeedItem = {
    itemId: item.remoteId,
    title: item.title,
    coverUrl: remoteCover ?? cachedCover,
    coverWidth: 0,
    coverHeight: 0,
    authorName: item.author || "匿名用户",
    authorAvatar: null,
    prompt: promptText,
    modelName,
    imageUrl: (!isOldFormat && meta.i) || null,
    imageWidth: 0,
    imageHeight: 0,
    workType,
    videoUrl,
    videoDurationMs: 0,
    likeCount: item.likeCount,
    usageCount: 0,
    createTime: item.remoteCreatedAt,
    updateTime: item.remoteUpdatedAt,
    effectType: workType === "video" ? 53 : 9,
  };

  const payload = buildJimengPayload(jimengItem);
  if (!payload.content.trim()) throw new Error("作品无可采集内容");

  const sourceUrl = `https://jimeng.jianying.com/ai-tool/work/${item.remoteId}`;
  const prompt = await db.prompt.create({
    data: {
      userId: importerId,
      title: item.title,
      content: payload.content,
      type: payload.type,
      category: payload.category,
      language: "zh",
      tags: finalTags,
      sourceSite: "jimeng.jianying.com",
      sourceAuthor: item.author,
      sourceUrl,
      likeCount: item.likeCount,
      status: "published",
      publishedAt: item.remoteCreatedAt ?? null,
      adminAuthorId: adminId,
    },
  });

  const manifestPath = manifestFile("jimeng", item.remoteId);
  const manifest = readManifest(manifestPath);
  const media: any[] = [];
  let coverUrl: string | null = null;
  // 优先复用 fetch 阶段缓存到本地的封面（不二次下载，也规避远端签名过期）
  const cachedCoverPath = cachedCover ? uploadUrlToPath(cachedCover) : null;
  let localCover: string | null =
    cachedCover && cachedCoverPath && existsSync(cachedCoverPath) && statSync(cachedCoverPath).size > 0
      ? cachedCover
      : null;
  if (!localCover && payload.coverUrl) {
    localCover = reuseUpload(manifest, payload.coverUrl, "image");
    if (!localCover) {
      const buf = await fetchImageWebp(payload.coverUrl, "jimeng");
      if (buf) {
        const saved = saveUploadSync("image", "webp", buf);
        localCover = saved.url;
        manifest[payload.coverUrl] = { url: localCover, type: "image" };
      }
    }
  }
  if (localCover) {
    coverUrl = localCover;
    media.push({
      type: "image",
      role: "cover",
      url: localCover,
      sourceUrl: remoteCover || cachedCover || payload.coverUrl,
      alt: item.title,
    });
  }
  let imgOk = 0;
  let frameOk = 0;
  let envWarning = "";
  for (const m of payload.mediaPlan as JimengMediaPlanItem[]) {
    const isVideo = m.kind === "video";
    const key = isVideo ? `${m.url}#frame` : m.url;
    let url = reuseUpload(manifest, key, "image");
    if (!url) {
      let buf: Buffer | null = null;
      if (isVideo) {
        const shot = await screenshotVideo(m.url, "jimeng");
        buf = shot.buf;
        if (!buf && shot.envError && !envWarning) envWarning = `截帧失败：${shot.envError}`;
      } else {
        buf = await fetchImageWebp(m.url, "jimeng");
      }
      if (!buf) continue;
      const saved = saveUploadSync("image", "webp", buf);
      url = saved.url;
      manifest[key] = { url, type: "image" };
    }
    if (isVideo) frameOk++;
    else imgOk++;
    media.push({
      type: "image",
      role: "node",
      url,
      section: m.section,
      nodeKind: m.kind,
      sourceUrl: m.url,
      alt: m.alt,
    });
    await sleep(80);
  }

  writeManifest(manifestPath, manifest);

  await db.prompt.update({
    where: { id: prompt.id },
    data: { media, ...(coverUrl ? { coverUrl } : {}) },
  });
  await syncPromptToMeili({
    id: prompt.id,
    title: prompt.title,
    content: prompt.content,
    description: null,
    type: prompt.type,
    category: prompt.category,
    language: prompt.language,
    tags: prompt.tags,
    likeCount: prompt.likeCount,
    viewCount: 0,
    createdAt: prompt.createdAt,
    sourceAuthor: prompt.sourceAuthor,
    coverUrl: coverUrl,
  });

  await db.crawlItem.update({
    where: { id: item.id },
    data: {
      status: "collected",
      error: envWarning ? `[告警] ${envWarning}` : null,
      kind: payload.type,
      promptId: prompt.id,
      collectedAt: new Date(),
    },
  });
  return { promptId: prompt.id, mediaCount: media.length, imgOk, frameOk, coverOk: Boolean(coverUrl), envWarning: envWarning || undefined };
}

// ─── 任务运行态登记：用于「中断采集」与「卡死任务自愈」 ───
const activeJobs = new Set<number>();
const cancelledJobs = new Set<number>();

export function isJobActive(jobId: number): boolean {
  return activeJobs.has(jobId);
}

// 请求中断：置标记后，循环在下一条目开始前退出
export function requestCancelCrawlJob(jobId: number): void {
  cancelledJobs.add(jobId);
}

export async function runCrawlJob(jobId: number) {
  const job = await db.crawlJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  let succeeded = 0;
  let failed = 0;
  let warned = 0;
  let cancelled = false;
  const importFn = IMPORT_FNS[job.source] || importLibtvItem;
  if (!IMPORT_FNS[job.source]) {
    await db.crawlJob.update({
      where: { id: jobId },
      data: { status: "done", finishedAt: new Date(), message: `未知采集源 ${job.source}` },
    });
    return;
  }
  try {
    const importer = await ensureImporter(job.source);
    for (const itemId of job.itemIds) {
      if (cancelledJobs.has(jobId)) {
        cancelled = true;
        break;
      }
      try {
        const r = await importFn(itemId, importer.id, job.adminId);
        if (!("skipped" in r)) {
          succeeded++;
          if (r.envWarning) warned++;
        }
      } catch (e: any) {
        failed++;
        const msg = String(e?.message || e).slice(0, 300);
        await db.crawlItem.update({ where: { id: itemId }, data: { status: "failed", error: msg } }).catch(() => {});
        // 进度区只显示最后一条失败
        const it = await db.crawlItem.findUnique({ where: { id: itemId }, select: { title: true } }).catch(() => null);
        const lastError = `${it?.title ? `《${it.title}》：` : ""}${msg}`.slice(0, 300);
        const done = succeeded + failed;
        await db.crawlJob.update({
          where: { id: jobId },
          data: { done, succeeded, failed, lastError },
        });
        continue;
      }
      const done = succeeded + failed;
      await db.crawlJob.update({
        where: { id: jobId },
        data: { done, succeeded, failed },
      });
    }
    if (cancelled) {
      await db.crawlJob.update({
        where: { id: jobId },
        data: {
          status: "done",
          finishedAt: new Date(),
          done: succeeded + failed,
          succeeded,
          failed,
          message: `已手动中断：已处理 ${succeeded + failed}/${job.total} 条（成功 ${succeeded}，失败 ${failed}）`,
        },
      });
      return;
    }
    const doneNotes: string[] = [];
    if (failed) doneNotes.push(`${failed} 条失败，可在失败列表重试`);
    if (warned) doneNotes.push(`${warned} 条视频本地化告警（临时目录/环境错误，见条目告警）`);
    await db.crawlJob.update({
      where: { id: jobId },
      data: {
        status: "done",
        finishedAt: new Date(),
        message: doneNotes.length > 0 ? doneNotes.join("；") : null,
      },
    });
  } catch (e: any) {
    await db.crawlJob.update({
      where: { id: jobId },
      data: {
        status: "done",
        finishedAt: new Date(),
        message: "任务异常中断：" + String(e?.message || e).slice(0, 300),
        done: succeeded + failed,
        succeeded,
        failed: failed + 1,
      },
    });
  } finally {
    activeJobs.delete(jobId);
    cancelledJobs.delete(jobId);
  }
}

// 回收长时间卡死的 running 任务（PM2 重启等场景），返回清理数量
export async function reapStaleJobs(maxAgeMs = 45 * 60_000): Promise<number> {
  const r = await db.crawlJob.updateMany({
    where: { status: "running", createdAt: { lt: new Date(Date.now() - maxAgeMs) } },
    data: { status: "done", finishedAt: new Date(), message: "任务超时（可能因服务重启中断）" },
  });
  return r.count;
}

// 触发但不等待（API 路由调用后立即返回 jobId）
export function startCrawlJobInBackground(jobId: number) {
  activeJobs.add(jobId);
  void runCrawlJob(jobId).catch((e) => {
    console.error("crawl job crashed:", e);
    activeJobs.delete(jobId);
    cancelledJobs.delete(jobId);
  });
}

// 自愈：库里有 running 任务、但内存里没有对应执行句柄（服务重启/进程退出）→ 标记中断
export async function healOrphanJob(jobId: number): Promise<boolean> {
  if (activeJobs.has(jobId)) return false;
  const r = await db.crawlJob.updateMany({
    where: { id: jobId, status: "running" },
    data: { status: "done", finishedAt: new Date(), message: "任务已中断（服务重启或进程退出，可重新发起采集）" },
  });
  return r.count > 0;
}
