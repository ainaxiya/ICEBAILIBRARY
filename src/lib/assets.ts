import crypto from "crypto";
import type { StorageBucket } from "@prisma/client";
import { db } from "@/lib/db";
import { bucketToConfig, putObject } from "@/lib/s3";

// ─── P5 生成产物转存（方案 7.4） ───
// 生成成功即转存默认存储桶（StorageBucket isDefault=true），写 generated_asset：
//   status=temp，expireAt=now+30 天；访问走签名 URL（私有读）。
// 转存失败不退扣分（生成已发生）：资产标 deleted 并留存 sourceUrl，
// 允许用户经 assets API 重试拉取一次（成功后清 sourceUrl，不再可重试）。

const EXPIRE_DAYS = 30;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export type AssetType = "image" | "video" | "audio" | "file";

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
};

function extOf(contentType: string, url: string): string {
  if (EXT_BY_MIME[contentType]) return EXT_BY_MIME[contentType];
  const m = /\.([a-zA-Z0-9]{2,5})(?:$|\?)/.exec(url);
  return m ? `.${m[1].toLowerCase()}` : ".bin";
}

// 去掉末尾扩展名（object key 的 uuid 段不含点，可安全剥离）
function stripExt(key: string): string {
  return key.replace(/\.[^./]+$/, "");
}

// 下载上游产物（http(s) 或 data: base64）
async function fetchSource(sourceUrl: string): Promise<{ bytes: Buffer; contentType: string; ext: string }> {
  if (sourceUrl.startsWith("data:")) {
    const m = /^data:([^;,]*)(?:;[^,]*)?;base64,([\s\S]+)$/.exec(sourceUrl);
    if (!m) throw new Error("data URL 格式错误");
    const contentType = m[1] || "application/octet-stream";
    return { bytes: Buffer.from(m[2], "base64"), contentType, ext: extOf(contentType, "") };
  }
  const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`下载产物失败 HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
  return { bytes, contentType: contentType || "application/octet-stream", ext: extOf(contentType, sourceUrl) };
}

async function defaultBucket(): Promise<StorageBucket> {
  const bucket = await db.storageBucket.findFirst({
    where: { isDefault: true, enabled: true },
    orderBy: { id: "asc" },
  });
  if (!bucket) throw new Error("未配置默认存储桶");
  return bucket;
}

function objectKeyBase(userId: number): string {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `generated/${userId}/${ym}/${crypto.randomUUID()}`;
}

// 生成成功即转存：成功写 temp 资产；失败写 deleted 资产（留 sourceUrl 供重试一次）
export async function saveGeneratedAsset(opts: {
  userId: number;
  usageRecordId?: bigint | null;
  assetType: AssetType;
  // 上游产物 URL（http(s) 或 data:）
  resultUrl: string;
}): Promise<SaveAssetResult> {
  const base = objectKeyBase(opts.userId);
  const expireAt = new Date(Date.now() + EXPIRE_DAYS * 86400000);
  try {
    const bucket = await defaultBucket();
    const src = await fetchSource(opts.resultUrl);
    const key = base + src.ext;
    await putObject(bucketToConfig(bucket), key, src.bytes, src.contentType);
    const asset = await db.generatedAsset.create({
      data: {
        userId: opts.userId,
        usageRecordId: opts.usageRecordId ?? null,
        assetType: opts.assetType,
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
          sourceUrl: opts.resultUrl,
        },
      });
      return { ok: false, assetId: asset.id, error: msg };
    } catch {
      return { ok: false, assetId: null, error: msg };
    }
  }
}

// 重试拉取一次（仅 status=deleted 且留存 sourceUrl 的资产）：
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
    const key = `${stripExt(asset.storageKey)}${src.ext}`;
    await putObject(bucketToConfig(bucket), key, src.bytes, src.contentType);
    await db.generatedAsset.update({
      where: { id: asset.id },
      data: {
        bucketId: bucket.id,
        storageKey: key,
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
