// 采集封面本地缓存：即梦封面 URL 带短时效签名（x-expires），过期后后台列表与详情图会裂。
// fetch 阶段就把封面下载、sharp 压成 webp 落到 public/uploads（口径同 crawl-worker：只走本地），
// CrawlItem.coverUrl 存本地路径，远端地址另存 tags meta.c，供入库阶段复用。
import sharp from "sharp";
import { saveUploadSync } from "./upload-store.server";
import { JIMENG_HEADERS } from "./crawl-jimeng";
import { LIBTV_HEADERS } from "./crawl-libtv";

export type CoverSource = "jimeng" | "libtv";

const MAX_COVER_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

function headersFor(source: CoverSource) {
  return source === "jimeng" ? JIMENG_HEADERS : LIBTV_HEADERS;
}

// 下载单张远端封面 → 本地 webp；失败返回 null（调用方保留远端 URL 兜底）
export async function cacheRemoteCover(url: string, source: CoverSource = "jimeng"): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const h = headersFor(source);
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": h["User-Agent"],
        Referer: h.Referer,
        Origin: (h as { Origin?: string }).Origin || h.Referer,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const declared = Number(r.headers.get("content-length") || 0);
    if (declared > MAX_COVER_BYTES) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_COVER_BYTES) return null;
    const webp = await sharp(buf, { failOn: "none" })
      .rotate()
      .resize({ width: 1280, height: 1920, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
    return saveUploadSync("image", "webp", webp).url;
  } catch {
    return null;
  }
}

// 批量缓存（去重 + 有限并发）；返回 远端 URL → 本地路径
export async function cacheRemoteCovers(
  urls: string[],
  source: CoverSource = "jimeng",
  concurrency = 6
): Promise<Map<string, string>> {
  const unique = [...new Set(urls.filter((u) => /^https?:\/\//i.test(u)))];
  const out = new Map<string, string>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), unique.length) }, async () => {
    while (cursor < unique.length) {
      const url = unique[cursor++];
      const local = await cacheRemoteCover(url, source);
      if (local) out.set(url, local);
    }
  });
  await Promise.all(workers);
  return out;
}

// 入库阶段封面来源判定：远端签名地址优先（能拿到就用），失败时回退 fetch 阶段已缓存的本地封面
export function resolveCoverSources(
  itemCoverUrl: string | null | undefined,
  metaCover: string | null | undefined
): { remote: string | null; cached: string | null } {
  const isHttp = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u);
  const remote = isHttp(metaCover) ? metaCover : isHttp(itemCoverUrl) ? itemCoverUrl : null;
  const cached = typeof itemCoverUrl === "string" && itemCoverUrl.startsWith("/uploads/") ? itemCoverUrl : null;
  return { remote, cached };
}
