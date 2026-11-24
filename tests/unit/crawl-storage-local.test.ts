import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { saveUploadSync } from "@/lib/upload-store.server";

// ─── 采集存储口径：LIBTV 采集产物永远只落本地，忽略默认桶（桶按流量计费） ───
// 与「用户主动上传可进默认桶」（src/lib/upload-core.server.ts saveUserMedia）是两套口径。

const readSrc = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

let bucketId: number | null = null;

beforeAll(async () => {
  // 造一个「存在且配了公开域名」的默认桶，模拟后台已启用对象存储
  const bucket = await db.storageBucket.create({
    data: {
      name: "unit-default-bucket",
      type: "minio",
      endpoint: "https://minio.test.local",
      bucket: "iceb",
      accessKey: "test-ak",
      secretKey: "enc:v1:iv:tag:cipher",
      publicBaseUrl: "https://cdn.test.local",
      isDefault: true,
      enabled: true,
    },
  });
  bucketId = bucket.id;
});

afterAll(async () => {
  if (bucketId) await db.storageBucket.delete({ where: { id: bucketId } }).catch(() => {});
  await db.$disconnect();
});

describe("采集落盘只走本地", () => {
  it("存在默认桶时，本地落盘函数仍返回 /uploads/ 路径并真实写入", () => {
    const saved = saveUploadSync("image", "webp", Buffer.from("unit-test"));
    try {
      expect(saved.url.startsWith("/uploads/")).toBe(true);
      expect(saved.url).toMatch(/^\/uploads\/\d{4}-\d{2}\/image-\d+-[A-Za-z0-9]{12}\.webp$/);
      expect(saved.url.startsWith("http")).toBe(false);
      expect(existsSync(saved.filePath)).toBe(true);
    } finally {
      if (existsSync(saved.filePath)) unlinkSync(saved.filePath);
    }
  });

  it("采集 worker 源码不调用桶上传能力（不回退成跟随默认桶）", () => {
    for (const rel of ["src/lib/crawl-worker.ts", "src/lib/crawl-libtv.ts"]) {
      const src = readSrc(rel);
      // 只认「实际调用」：注释里提到口径说明不算
      expect(src).not.toMatch(/putObject\s*\(|bucketToConfig\s*\(|db\.storageBucket|from ["']@\/lib\/s3["']/);
      expect(src).not.toMatch(/saveUserMedia\s*\(/);
    }
    // 采集落盘只走本地同步写盘
    expect(readSrc("src/lib/crawl-worker.ts")).toMatch(/saveUploadSync/);
  });
});
