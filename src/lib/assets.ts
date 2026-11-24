import crypto from "crypto";
import type { StorageBucket } from "@prisma/client";
import { db } from "@/lib/db";
import { bucketToConfig, getObject, putObject } from "@/lib/s3";
import { fetchWithSsrfGuard, readBodyCapped } from "@/lib/net-guard";
import { refineAssetType, type AssetType } from "@/lib/asset-types";

// ─── P5 生成产物转存（方案 7.4） ───
// 生成成功即转存默认存储桶（StorageBucket isDefault=true），写 generated_asset：
//   status=temp，expireAt=now+30 天；访问走签名 URL（私有读）。
// 转存失败不退扣分（生成已发生）：资产标 deleted 并留存 sourceUrl，
// 允许用户经 assets API 重试拉取一次（成功后清 sourceUrl，不再可重试）。

const EXPIRE_DAYS = 30;

export interface SaveAssetResult {
  ok: boolean;
  assetId: bigint | null;
  error?: string;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "model/gltf-binary": ".glb",
  "model/gltf+json": ".gltf",
  "model/obj": ".obj",
  "application/x-fbx": ".fbx",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/x-7z-compressed": ".7z",
  "application/vnd.rar": ".rar",
};

function extOf(contentType: string, url: string): string {
  if (EXT_BY_MIME[contentType]) return EXT_BY_MIME[contentType];
  const m = /\.([a-zA-Z0-9]{2,5})(?:$|\?)/.exec(url);
  return m ? `.${m[1].toLowerCase()}` : ".bin";
}

// ─── 文件头魔数判定（优先于上游 content-type） ───
// 上游产物常返回 application/octet-stream 且 URL 无扩展名，只信响应头会落成 .bin。
// 这里按真实字节判定类型，上游 content-type 仅作兜底。
const MAGIC_RULES: Array<{ ext: string; mime: string; match: (b: Buffer) => boolean }> = [
  { ext: ".png", mime: "image/png", match: (b) => b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" },
  { ext: ".jpg", mime: "image/jpeg", match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: ".webp",
    mime: "image/webp",
    match: (b) => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
  { ext: ".gif", mime: "image/gif", match: (b) => b.length >= 6 && b.subarray(0, 4).toString("latin1") === "GIF8" },
  {
    ext: ".wav",
    mime: "audio/wav",
    match: (b) => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WAVE",
  },
  // 3D：glb 二进制 / fbx 二进制 / obj 纯文本 / gltf JSON
  { ext: ".glb", mime: "model/gltf-binary", match: (b) => b.length >= 4 && b.subarray(0, 4).toString("latin1") === "glTF" },
  {
    ext: ".fbx",
    mime: "application/x-fbx",
    match: (b) => b.length >= 18 && b.subarray(0, 18).toString("latin1") === "Kaydara FBX Binary",
  },
  {
    ext: ".obj",
    mime: "model/obj",
    match: (b) => {
      const head = b.subarray(0, 64).toString("utf8").replace(/^\uFEFF/, "").trimStart().toLowerCase();
      return /^(#|v\s|o\s|g\s|mtllib\s|usemtl\s|s\s)/.test(head);
    },
  },
  {
    ext: ".gltf",
    mime: "model/gltf+json",
    match: (b) => {
      const head = b.subarray(0, 4096).toString("utf8").trimStart();
      return head.startsWith("{") && head.includes('"asset"');
    },
  },
  // 压缩包
  { ext: ".zip", mime: "application/zip", match: (b) => b.length >= 4 && b.subarray(0, 4).toString("hex") === "504b0304" },
  {
    ext: ".gz",
    mime: "application/gzip",
    match: (b) => b.length >= 3 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 0x08,
  },
  {
    ext: ".7z",
    mime: "application/x-7z-compressed",
    match: (b) => b.length >= 6 && b.subarray(0, 6).toString("hex") === "377abcaf271c",
  },
  {
    ext: ".rar",
    mime: "application/vnd.rar",
    match: (b) => b.length >= 6 && b.subarray(0, 6).toString("latin1") === "Rar!\u001a\u0007",
  },
  { ext: ".pdf", mime: "application/pdf", match: (b) => b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-" },
  // 其它音频：m4a 走 ftyp brand，ogg/flac 走容器魔数，aac(ADTS) 必须先于 mp3（两者帧同步位重叠）
  {
    ext: ".m4a",
    mime: "audio/mp4",
    match: (b) =>
      b.length >= 12 &&
      b.subarray(4, 8).toString("latin1") === "ftyp" &&
      ["M4A ", "M4B "].includes(b.subarray(8, 12).toString("latin1")),
  },
  { ext: ".ogg", mime: "audio/ogg", match: (b) => b.length >= 4 && b.subarray(0, 4).toString("latin1") === "OggS" },
  { ext: ".flac", mime: "audio/flac", match: (b) => b.length >= 4 && b.subarray(0, 4).toString("latin1") === "fLaC" },
  {
    ext: ".aac",
    mime: "audio/aac",
    // ADTS：12 位同步字 0xFFF + layer 位为 00；MP3 的 layer 位非 0
    match: (b) => b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0,
  },
  {
    // MP4 / MOV / HEIF 共用 ftyp box：brand=qt 视为 .mov，其余按 .mp4
    ext: ".mp4",
    mime: "video/mp4",
    match: (b) => b.length >= 8 && b.subarray(4, 8).toString("latin1") === "ftyp",
  },
  {
    ext: ".mp3",
    mime: "audio/mpeg",
    match: (b) =>
      (b.length >= 3 && b.subarray(0, 3).toString("latin1") === "ID3") ||
      (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0),
  },
];

export function sniffMediaType(bytes: Buffer): { ext: string; mime: string } | null {
  for (const rule of MAGIC_RULES) {
    if (bytes.length && rule.match(bytes)) {
      // MOV 细分：ftyp 后 8-12 字节为 brand
      if (rule.ext === ".mp4" && bytes.subarray(8, 12).toString("latin1") === "qt  ") {
        return { ext: ".mov", mime: "video/quicktime" };
      }
      return { ext: rule.ext, mime: rule.mime };
    }
  }
  return null;
}

// 去掉末尾扩展名（object key 的 uuid 段不含点，可安全剥离）
function stripExt(key: string): string {
  return key.replace(/\.[^./]+$/, "");
}

// ─── S0-6 SSRF 防护：协议白名单 + 私网地址拦截 + 限跳重定向 + 响应体上限 ───
// 实现在 src/lib/net-guard.ts（与实验场媒体落盘共用同一套）

// 下载上游产物（http(s) 或 data: base64）
async function fetchSource(sourceUrl: string): Promise<{ bytes: Buffer; contentType: string; ext: string }> {
  if (sourceUrl.startsWith("data:")) {
    const m = /^data:([^;,]*)(?:;[^,]*)?;base64,([\s\S]+)$/.exec(sourceUrl);
    if (!m) throw new Error("data URL 格式错误");
    const contentType = m[1] || "application/octet-stream";
    return { bytes: Buffer.from(m[2], "base64"), contentType, ext: extOf(contentType, "") };
  }
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new Error("产物地址格式错误");
  }
  const res = await fetchWithSsrfGuard(url);
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new Error(`下载产物失败 HTTP ${res.status}`);
  }
  const bytes = await readBodyCapped(res);
  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
  return { bytes, contentType: contentType || "application/octet-stream", ext: extOf(contentType, sourceUrl) };
}

// 存储口径（白名单）：用户产物（generated_asset）允许进默认桶，
// 但桶必须配置公开读域名（后台已改公开桶），否则回退报错而不是产出打不开的链接。
async function defaultBucket(): Promise<StorageBucket> {
  const bucket = await db.storageBucket.findFirst({
    where: { isDefault: true, enabled: true },
    orderBy: { id: "asc" },
  });
  if (!bucket) throw new Error("未配置默认存储桶");
  if (!bucket.publicBaseUrl) throw new Error("默认存储桶未配置公开访问域名");
  return bucket;
}

function objectKeyBase(userId: number): string {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `generated/${userId}/${ym}/${crypto.randomUUID()}`;
}

// 生成成功即转存：成功写 temp 资产；失败写 deleted 资产（留 sourceUrl 供重试一次）
// content（可选）：上游产物需要鉴权下载时由 adapter 直接给出二进制，跳过 URL 拉取
export async function saveGeneratedAsset(opts: {
  userId: number;
  usageRecordId?: bigint | null;
  assetType: AssetType;
  // 上游产物 URL（http(s) 或 data:）；与 content 二选一
  resultUrl?: string;
  // 已下载好的产物二进制（视频 /content 场景），与 resultUrl 二选一
  content?: { bytes: Buffer; contentType: string };
}): Promise<SaveAssetResult> {
  const base = objectKeyBase(opts.userId);
  const expireAt = new Date(Date.now() + EXPIRE_DAYS * 86400000);
  const source = async () => {
    if (opts.content) {
      const contentType = opts.content.contentType || "application/octet-stream";
      return { bytes: opts.content.bytes, contentType, ext: extOf(contentType, "") };
    }
    if (!opts.resultUrl) throw new Error("缺少产物来源");
    return fetchSource(opts.resultUrl);
  };
  try {
    const bucket = await defaultBucket();
    const src = await source();
    // 以真实文件头为准：上游常给 application/octet-stream 且 URL 无扩展名
    const sniff = sniffMediaType(src.bytes);
    const mime = sniff?.mime ?? null;
    const key = base + (sniff?.ext ?? src.ext);
    await putObject(bucketToConfig(bucket), key, src.bytes, mime ?? src.contentType);
    const asset = await db.generatedAsset.create({
      data: {
        userId: opts.userId,
        usageRecordId: opts.usageRecordId ?? null,
        // 通用 file 按真实 MIME 升级分类；明确分类（image/video/speech…）保持不变
        assetType: refineAssetType(opts.assetType, mime),
        // 只记嗅探出的真实 MIME；嗅探不出保持 NULL，不拿 application/octet-stream 充数
        mimeType: mime,
        bucketId: bucket.id,
        storageKey: key,
        sizeBytes: BigInt(src.bytes.length),
        sha256Hex: crypto.createHash("sha256").update(src.bytes).digest("hex"),
        status: "temp",
        expireAt,
      },
    });
    return { ok: true, assetId: asset.id };
  } catch (e) {
    const msg = (e as Error).message || "转存失败";
    // 只留存可重试的 http(s) 来源：data URL / 二进制产物没有外部地址，
    // 存进 sourceUrl 会把整段 base64 写进库（大字段膨胀），也无法据此重试
    const retryUrl =
      opts.resultUrl && !opts.resultUrl.startsWith("data:") ? opts.resultUrl : null;
    try {
      const asset = await db.generatedAsset.create({
        data: {
          userId: opts.userId,
          usageRecordId: opts.usageRecordId ?? null,
          assetType: opts.assetType,
          bucketId: null,
          storageKey: `${base}.pending`,
          sizeBytes: 0,
          status: "deleted",
          expireAt,
          sourceUrl: retryUrl,
        },
      });
      return { ok: false, assetId: asset.id, error: msg };
    } catch {
      return { ok: false, assetId: null, error: msg };
    }
  }
}

// 存量回填：只读对象字节、只更新 mimeType，不动对象本身、不改 assetType 历史值。
// 嗅探不出的记录保持 NULL（跳过），不拿 octet-stream 乱填。
export interface MimeBackfillResult {
  scanned: number;
  updated: number;
  skipped: number;
  details: Array<{ id: string; storageKey: string; mime: string | null }>;
}

export async function backfillAssetMimeTypes(limit = 200): Promise<MimeBackfillResult> {
  const rows = await db.generatedAsset.findMany({
    where: { mimeType: null, status: "temp", bucketId: { not: null } },
    include: { bucket: true },
    orderBy: { id: "asc" },
    take: Math.max(1, Math.min(limit, 500)),
  });
  const result: MimeBackfillResult = { scanned: rows.length, updated: 0, skipped: 0, details: [] };
  for (const row of rows) {
    let mime: string | null = null;
    if (row.bucket) {
      try {
        mime = sniffMediaType(await getObject(bucketToConfig(row.bucket), row.storageKey))?.mime ?? null;
      } catch {
        // 单条对象读取失败不影响其它记录，保持 NULL 跳过
      }
    }
    if (!mime) {
      result.skipped += 1;
      result.details.push({ id: String(row.id), storageKey: row.storageKey, mime: null });
      continue;
    }
    await db.generatedAsset.update({ where: { id: row.id }, data: { mimeType: mime } });
    result.updated += 1;
    result.details.push({ id: String(row.id), storageKey: row.storageKey, mime });
  }
  return result;
}

// 成功 → status=temp 并清 sourceUrl（不可再重试）；失败保持 deleted
export async function retryAssetTransfer(
  assetId: bigint,
  userId: number
): Promise<{ ok: boolean; error?: string }> {
  const asset = await db.generatedAsset.findFirst({
    where: { id: assetId, userId, status: "deleted" },
  });
  if (!asset) return { ok: false, error: "资产不存在或无需重试拉取" };
  if (!asset.sourceUrl) return { ok: false, error: "该资产不可重试拉取" };

  try {
    const bucket = await defaultBucket();
    const src = await fetchSource(asset.sourceUrl);
    // 重试同样以真实文件头为准，并补写 mimeType（不改存量 assetType 值）
    const sniff = sniffMediaType(src.bytes);
    const key = `${stripExt(asset.storageKey)}${sniff?.ext ?? src.ext}`;
    await putObject(bucketToConfig(bucket), key, src.bytes, sniff?.mime ?? src.contentType);
    await db.generatedAsset.update({
      where: { id: asset.id },
      data: {
        bucketId: bucket.id,
        storageKey: key,
        mimeType: sniff?.mime ?? null,
        sizeBytes: BigInt(src.bytes.length),
        sha256Hex: crypto.createHash("sha256").update(src.bytes).digest("hex"),
        status: "temp",
        expireAt: new Date(Date.now() + EXPIRE_DAYS * 86400000),
        sourceUrl: null,
      },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message || "重试拉取失败" };
  }
}
