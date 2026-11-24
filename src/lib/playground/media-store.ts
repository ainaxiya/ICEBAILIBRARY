import { saveUpload } from "@/lib/upload-store.server";
import { kindForExt } from "@/lib/upload-naming";
import { saveGeneratedAsset, sniffMediaType } from "@/lib/assets";
import type { AssetType } from "@/lib/asset-types";
import { fetchWithSsrfGuard, readBodyCapped } from "@/lib/net-guard";
import { db } from "@/lib/db";

// ─── 实验场产物落盘 ───
// 默认落本地磁盘（public/uploads/<YYYY-MM>/<类型名>-<时间刻度>-<随机12位>.<ext>），
// 与全站上传同一套命名/目录规则，本地开发不依赖对象存储凭据。
// 线上想走对象存储：PLAYGROUND_MEDIA_STORAGE=bucket，复用公共存储桶；
// 转存失败/未配置时**记日志并降级本地磁盘**，不静默丢产物。

const MODE = (process.env.PLAYGROUND_MEDIA_STORAGE || "local").toLowerCase();

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
};

export interface StoredAsset {
  url: string;
  /** local = 落本地磁盘；bucket = 公共存储桶；source = 两者都失败，直接用上游临时地址 */
  mode: "local" | "bucket" | "source";
  width: number | null;
  height: number | null;
  bytes: number;
}

function mimeOf(url: string): string | null {
  if (!url.startsWith("data:")) return null;
  const head = url.slice(5, url.indexOf(","));
  const m = /^([^;]+)/.exec(head);
  return m?.[1]?.trim().toLowerCase() ?? null;
}

// 单次转存下载上限（与产物转存 assets.ts 同一档 256MB），边下边计数，超限中断
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 180_000;

// 拉取上游产物：data: 直接解码（同样受体积上限约束）；http(s) 走统一 SSRF 防护
// （私网/回环/链路本地拦截 + 逐跳校验重定向最终地址 + 流式体积上限）
export async function fetchBytes(url: string): Promise<{ bytes: Buffer; mime: string | null }> {
  const inline = mimeOf(url);
  if (inline) {
    const b64 = url.slice(url.indexOf(",") + 1);
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length > MAX_ASSET_BYTES) throw new Error("产物体积超过下载上限");
    return { bytes, mime: inline };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("产物地址格式错误");
  }
  const res = await fetchWithSsrfGuard(parsed, { timeoutMs: FETCH_TIMEOUT_MS });
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new Error(`下载上游产物失败 HTTP ${res.status}`);
  }
  const bytes = await readBodyCapped(res, MAX_ASSET_BYTES);
  return {
    bytes,
    mime: (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() || null,
  };
}

function extOf(mime: string | null): string {
  return (mime && EXT_BY_TYPE[mime]) || "bin";
}

// 真实类型优先：上游常回 application/octet-stream 且地址无扩展名，
// 只信 content-type 会把 PNG/MP4 落成 .bin（浏览器按 octet-stream 处理，预览失败）。
// 与 src/lib/assets.ts 同一套魔数规则；存量文件不动，只影响新落盘。
function extForBytes(bytes: Buffer, mime: string | null): string {
  return sniffMediaType(bytes)?.ext.slice(1) ?? extOf(mime);
}

// 落本地磁盘（两种来源共用：URL 下载 / worker 直传字节）
async function writeLocal(opts: {
  userId: number;
  requestId: string;
  index: number;
  bytes: Buffer;
  mime: string | null;
  assetType?: AssetType;
}): Promise<StoredAsset> {
  const ext = extForBytes(opts.bytes, opts.mime);
  const saved = await saveUpload(kindForExt(ext), ext, opts.bytes);
  const dims = dimsOf(opts.bytes);
  // 会员产物：即使落本地磁盘也写 generated_asset，会员中心「我的资产」才看得到；
  // 游客（userId=0）不写。
  if (opts.userId > 0) {
    await db.generatedAsset
      .create({
        data: {
          userId: opts.userId,
          assetType: opts.assetType ?? "other",
          mimeType: sniffMediaType(opts.bytes)?.mime ?? opts.mime ?? null,
          storageKey: saved.url,
          sizeBytes: BigInt(opts.bytes.length),
          status: "temp",
          expireAt: new Date(Date.now() + 30 * 86400000),
        },
      })
      .catch((e) => console.error(`[playground] 资产记录写入失败 requestId=${opts.requestId}:`, e));
  }
  return {
    url: saved.url,
    mode: "local",
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    bytes: opts.bytes.length,
  };
}

// 只解析 PNG / JPEG 的像素尺寸，用于前端占位比例与验收核对；其它格式返回 null
function dimsOf(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf.slice(0, 8).toString("hex") === "89504e470d0a1a0a") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}

export async function storePlaygroundAsset(opts: {
  userId: number;
  requestId: string;
  index: number;
  assetType: AssetType;
  usageRecordId: bigint | null;
  sourceUrl: string;
  /** 游客任务：不写会员资产表（userId=0 不落库），直接落本地磁盘 */
  guest?: boolean;
}): Promise<StoredAsset> {
  if (MODE === "bucket" && !opts.guest) {
    try {
      const saved = await saveGeneratedAsset({
        userId: opts.userId,
        usageRecordId: opts.usageRecordId,
        assetType: opts.assetType,
        resultUrl: opts.sourceUrl,
      });
      if (saved.ok && saved.assetId != null) {
        return { url: `/api/member/assets/${saved.assetId}/download`, mode: "bucket", width: null, height: null, bytes: 0 };
      }
      console.error(
        `[playground] 对象存储转存失败（assetId=${saved.assetId ?? "null"}），降级本地磁盘 requestId=${opts.requestId}`
      );
    } catch (e) {
      console.error(`[playground] 对象存储转存异常，降级本地磁盘 requestId=${opts.requestId}:`, e);
    }
  }

  try {
    const { bytes, mime } = await fetchBytes(opts.sourceUrl);
    return await writeLocal({
      userId: opts.userId,
      requestId: opts.requestId,
      index: opts.index,
      bytes,
      mime,
      assetType: opts.assetType,
    });
  } catch (e) {
    console.error(`[playground] 本地落盘失败，退回上游临时地址 requestId=${opts.requestId}:`, e);
    return { url: opts.sourceUrl, mode: "source", width: null, height: null, bytes: 0 };
  }
}

// worker 已带鉴权下载到内存的产物（如上游 /videos/{id}/content 需 Authorization），
// 无法再用 URL 取一次，直接写盘；落盘失败向上抛，由 worker 判失败退分（不退回需鉴权的临时地址）。
export async function storePlaygroundBytes(opts: {
  userId: number;
  requestId: string;
  index: number;
  bytes: Buffer;
  mime: string | null;
  assetType?: AssetType;
}): Promise<StoredAsset> {
  return writeLocal(opts);
}
