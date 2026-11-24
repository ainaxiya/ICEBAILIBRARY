import { beforeEach, describe, expect, it, vi } from "vitest";

// 存储口径（白名单）：/api/upload（富文本图片/视频、提示词封面）一律本地落盘，
// 即使后台存在默认桶也不进桶、不查询桶配置。
const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  saveUpload: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { storageBucket: { findFirst: mocks.findFirst } },
}));
vi.mock("@/lib/upload-store.server", () => ({
  saveUpload: mocks.saveUpload,
}));

import { saveUserMedia } from "@/lib/upload-core.server";

// 最小合法 PNG 头（sniffKind 只校验前 8 字节，长度需 ≥12）
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const pngFile = () => new File([PNG], "a.png", { type: "image/png" });

describe("saveUserMedia 存储口径", () => {
  beforeEach(() => {
    mocks.findFirst.mockReset();
    mocks.saveUpload.mockReset();
    mocks.saveUpload.mockResolvedValue({ url: "/uploads/2026-11/local.png" });
  });

  it("存在默认桶（含公开域名）也不进桶，且根本不查询桶配置", async () => {
    mocks.findFirst.mockResolvedValue({
      id: 1,
      bucket: "media",
      publicBaseUrl: "https://cdn.example.com/",
    });

    const saved = await saveUserMedia(pngFile(), { maxImageMB: 5, maxVideoMB: 100 });

    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.saveUpload).toHaveBeenCalledTimes(1);
    expect(saved.url).toBe("/uploads/2026-11/local.png");
    expect(saved.type).toBe("image");
  });

  it("命名沿用本地规则：image|video-时间戳-随机12位", async () => {
    mocks.saveUpload.mockImplementation(async (kind: string, ext: string) => ({
      url: `/uploads/2026-11/${kind}-1795000000000-abcdefABCDEF${ext}`,
    }));

    const saved = await saveUserMedia(pngFile(), { maxImageMB: 5, maxVideoMB: 100 });

    expect(mocks.saveUpload).toHaveBeenCalledWith("image", ".png", expect.any(Buffer));
    expect(saved.url).toMatch(/^\/uploads\/\d{4}-\d{2}\/image-\d+-[A-Za-z0-9]{12}\.png$/);
  });

  it("内容与声明类型不符仍拒绝（与存储口径无关的既有校验）", async () => {
    await expect(
      saveUserMedia(new File([PNG], "a.png", { type: "video/mp4" }), { maxImageMB: 5, maxVideoMB: 100 })
    ).rejects.toThrow();
  });
});
