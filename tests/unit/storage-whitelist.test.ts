import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { saveUserMedia } from "@/lib/upload-core.server";
import { saveUpload } from "@/lib/upload-store.server";

// ─── 存储白名单：仅「后台技能压缩包」与「用户产物」可进默认桶 ───
// 头像、富文本图片/视频、提示词封面、采集产物一律本地 public/uploads/YYYY-MM/。
// 本用例在「存在默认桶且配了公开域名」的真实环境下验证。

const readSrc = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const pngFile = () => new File([PNG], "cover.png", { type: "image/png" });

let bucketId: number | null = null;
const tmp: string[] = [];

beforeAll(async () => {
  const bucket = await db.storageBucket.create({
    data: {
      name: "unit-public-default",
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
  for (const p of tmp) if (existsSync(p)) unlinkSync(p);
  if (bucketId) await db.storageBucket.delete({ where: { id: bucketId } }).catch(() => {});
  await db.$disconnect();
});

describe("默认桶存在时，白名单外的一律本地", () => {
  it("富文本图片 / 提示词封面（saveUserMedia）返回本地 /uploads 路径并真实落盘", async () => {
    const saved = await saveUserMedia(pngFile(), { maxImageMB: 5, maxVideoMB: 100 });
    expect(saved.url).toMatch(/^\/uploads\/\d{4}-\d{2}\/image-\d+-[A-Za-z0-9]{12}\.png$/);

    const filePath = path.join(process.cwd(), "public", saved.url.replace(/^\//, ""));
    tmp.push(filePath);
    expect(existsSync(filePath)).toBe(true);
  });

  it("头像（saveUpload 落盘函数）同样只落本地", async () => {
    const saved = await saveUpload("image", "webp", Buffer.from("avatar-unit"));
    expect(saved.url).toMatch(/^\/uploads\/\d{4}-\d{2}\/image-\d+-[A-Za-z0-9]{12}\.webp$/);
    tmp.push(saved.filePath);
    expect(existsSync(saved.filePath)).toBe(true);
  });
});

describe("白名单两类仍走默认桶", () => {
  it("技能压缩包：导入接口 putObject 到默认桶，且要求公开访问域名", () => {
    const src = readSrc("src/app/api/admin/skills/import/route.ts");
    expect(src).toMatch(/putObject\s*\(/);
    expect(src).toMatch(/isDefault: true/);
    expect(src).toMatch(/publicBaseUrl/);
  });

  it("用户产物：assets 转存默认桶，且要求公开访问域名", () => {
    const src = readSrc("src/lib/assets.ts");
    expect(src).toMatch(/putObject\s*\(/);
    expect(src).toMatch(/isDefault: true/);
    expect(src).toMatch(/publicBaseUrl/);
  });
});

describe("非白名单上传入口不引用桶上传", () => {
  it("头像路由与通用上传核心只用本地写盘", () => {
    for (const rel of [
      "src/app/api/user/avatar/upload/route.ts",
      "src/app/api/admin/users/[id]/avatar/upload/route.ts",
      "src/lib/upload-core.server.ts",
    ]) {
      const src = readSrc(rel);
      expect(src).not.toMatch(/putObject\s*\(|bucketToConfig\s*\(|db\.storageBucket/);
      expect(src).toMatch(/saveUpload/);
    }
  });
});
