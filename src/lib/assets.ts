import crypto from "crypto";
import dns from "dns/promises";
import net from "net";
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
// S0-6 SSRF 加固：重定向跳数与响应体大小上限
const MAX_REDIRECTS = 3;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

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

// ─── S0-6 SSRF 防护：协议白名单 + 私网地址拦截 + 限跳重定向 + 响应体上限 ───

// 私网/保留地址判断（含 IPv4-mapped IPv6 与云 metadata 169.254.169.254）
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local（含云 metadata）
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // ULA
  if (v6.startsWith("fe80")) return true; // link-local
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7)); // v4-mapped
  return false;
}

// 主机必须是公网地址：字面 IP 直接判；域名解析后逐地址判
async function assertPublicHost(hostname: string): Promise<void> {
  if (/^localhost$/i.test(hostname) || hostname.endsWith(".localhost")) {
    throw new Error("SSRF blocked: localhost");
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("SSRF blocked: private address");
    return;
  }
  const addrs = await dns.lookup(hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error("产物地址 DNS 解析失败");
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error("SSRF blocked: private address");
  }
}

// 手动跟随重定向（每跳重新校验协议与目标地址），防止 302 绕过
async function fetchWithSsrfGuard(url: URL): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error("仅允许 http(s) 产物地址");
    }
    await assertPublicHost(current.hostname);
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (res.status >= 301 && res.status <= 308) {
      const loc = res.headers.get("location");
      res.body?.cancel().catch(() => {});
      if (!loc) throw new Error("重定向缺少 Location");
      current = new URL(loc, current);
      continue;
    }
    return res;
  }
  throw new Error("产物下载重定向次数过多");
}

// 流式读取响应体，超上限即中断（不把超大响应整块读进内存）
async function readBodyCapped(res: Response): Promise<Buffer> {
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new Error("产物体积超过下载上限");
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) {
      reader.cancel().catch(() => {});
      throw new Error("产物体积超过下载上限");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

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
