import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import sharp from "sharp";
import { cacheRemoteCover, cacheRemoteCovers, resolveCoverSources } from "@/lib/crawl-cover";

// ─── k3 采集封面本地缓存：远端签名 URL 过期后不再裂图 ───
// ① 远端图片 → webp 落 public/uploads，返回 /uploads/ 本地路径
// ② 非 http(s) 地址不发起下载（避免把已缓存的本地路径再当远端拉）
// ③ 下载/解码失败返回 null，调用方保留远端 URL 兜底
// ④ 入库阶段来源判定：远端优先，本地缓存兜底

const saved: string[] = [];

async function pngBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 12, height: 12, channels: 3, background: "#4f46e5" } })
    .png()
    .toBuffer();
}

beforeEach(() => {
  vi.restoreAllMocks();
  // 关闭 libvips 文件缓存，避免 Windows 上 test 结束仍占住落盘文件
  sharp.cache(false);
});

afterEach(() => {
  for (const url of saved.splice(0)) {
    const abs = url.replace(/^\/uploads\//, `${process.cwd()}/public/uploads/`);
    // Windows 上 sharp 可能短暂占住句柄：带重试删除，失败也不影响断言
    try {
      if (existsSync(abs)) rmSync(abs, { force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* 句柄未释放时忽略，测试产物不影响代码正确性 */
    }
  }
  vi.unstubAllGlobals();
});

describe("k3 封面本地缓存", () => {
  it("远端封面下载后落本地 webp，返回 /uploads 路径", async () => {
    const png = await pngBuffer();
    const fetchMock = vi.fn(async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);

    const local = await cacheRemoteCover("https://cdn.jimeng.test/cover.png?x-expires=1", "jimeng");
    expect(local).toMatch(/^\/uploads\/\d{4}-\d{2}\/image-[A-Za-z0-9-]+\.webp$/);
    saved.push(local!);

    const abs = local!.replace(/^\/uploads\//, `${process.cwd()}/public/uploads/`);
    expect(existsSync(abs)).toBe(true);
    // 落盘的是 webp 而不是原 png
    const meta = await sharp(abs).metadata();
    expect(meta.format).toBe("webp");
  });

  it("非 http(s) 地址直接返回 null，不发起请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await cacheRemoteCover("/uploads/2026-11/image-x.webp")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("远端不可用/解码失败返回 null（由调用方保留远端 URL 兜底）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    expect(await cacheRemoteCover("https://cdn.jimeng.test/cover.png")).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from("not-an-image"), { status: 200 })));
    expect(await cacheRemoteCover("https://cdn.jimeng.test/bad.png")).toBeNull();
  });

  it("批量缓存去重并返回映射", async () => {
    const png = await pngBuffer();
    const fetchMock = vi.fn(async () => new Response(png, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const map = await cacheRemoteCovers(
      ["https://cdn.jimeng.test/a.png", "https://cdn.jimeng.test/a.png", "/uploads/already-local.webp"],
      "jimeng",
      2
    );
    saved.push(...map.values());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(map.size).toBe(1);
    expect(map.has("https://cdn.jimeng.test/a.png")).toBe(true);
  });
});

describe("k3 入库阶段封面来源判定", () => {
  it("meta.c 远端优先，本地缓存兜底", () => {
    expect(resolveCoverSources("/uploads/x.webp", "https://cdn.test/c.png")).toEqual({
      remote: "https://cdn.test/c.png",
      cached: "/uploads/x.webp",
    });
  });

  it("旧数据无 meta.c 时用 CrawlItem 上的远端地址", () => {
    expect(resolveCoverSources("https://cdn.test/c.png", null)).toEqual({
      remote: "https://cdn.test/c.png",
      cached: null,
    });
  });

  it("只有本地封面时 remote 为 null，仍可入库", () => {
    expect(resolveCoverSources("/uploads/x.webp", undefined)).toEqual({
      remote: null,
      cached: "/uploads/x.webp",
    });
  });
});
