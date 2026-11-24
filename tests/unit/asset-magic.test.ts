import { beforeEach, describe, expect, it, vi } from "vitest";

// p15：落桶扩展名与 Content-Type 以真实文件头为准，上游 content-type 只作兜底
const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  putObject: vi.fn(),
  getObject: vi.fn(),
  assetFindMany: vi.fn(),
  assetUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    storageBucket: { findFirst: mocks.findFirst },
    generatedAsset: { create: mocks.create, findMany: mocks.assetFindMany, update: mocks.assetUpdate },
  },
}));
vi.mock("@/lib/s3", () => ({
  bucketToConfig: vi.fn(() => ({})),
  putObject: mocks.putObject,
  getObject: mocks.getObject,
  presignDownload: vi.fn(),
}));

import { backfillAssetMimeTypes, saveGeneratedAsset, sniffMediaType } from "@/lib/assets";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from("WEBPVP8 ", "latin1"),
]);
const GIF = Buffer.from("GIF89a0000", "latin1");
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1")]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  ", "latin1")]);
const MP3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]);
const GLB = Buffer.from("glTF\x02\x00\x00\x00", "latin1");
const FBX = Buffer.from("Kaydara FBX Binary  \x00\x1a\x00", "latin1");
const OBJ = Buffer.from("v 0.0 0.0 0.0\nvt 0.0 0.0\nf 1 2 3\n", "latin1");
const GLTF = Buffer.from('{"asset":{"version":"2.0"},"scenes":[]}', "utf8");
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A ", "latin1"), Buffer.from([0, 0, 0, 0])]);
const OGG = Buffer.from("OggS\x00\x02\x00\x00", "latin1");
const FLAC = Buffer.from("fLaC\x00\x00\x00\x22", "latin1");
const AAC = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0]);
const ZIP = Buffer.from("504b030414000000", "hex");
const GZ = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0]);
const SEVEN_Z = Buffer.from("377abcaf271c0000", "hex");
const RAR = Buffer.from("Rar!\x1a\x07\x00", "latin1");
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n", "latin1");

describe("sniffMediaType", () => {
  it("按文件头识别常见格式", () => {
    expect(sniffMediaType(PNG)).toEqual({ ext: ".png", mime: "image/png" });
    expect(sniffMediaType(JPEG)).toEqual({ ext: ".jpg", mime: "image/jpeg" });
    expect(sniffMediaType(WEBP)).toEqual({ ext: ".webp", mime: "image/webp" });
    expect(sniffMediaType(GIF)).toEqual({ ext: ".gif", mime: "image/gif" });
    expect(sniffMediaType(MP4)).toEqual({ ext: ".mp4", mime: "video/mp4" });
    expect(sniffMediaType(MOV)).toEqual({ ext: ".mov", mime: "video/quicktime" });
    expect(sniffMediaType(MP3)).toEqual({ ext: ".mp3", mime: "audio/mpeg" });
  });

  it("识别 3D 模型：glb / fbx / obj / gltf", () => {
    expect(sniffMediaType(GLB)).toEqual({ ext: ".glb", mime: "model/gltf-binary" });
    expect(sniffMediaType(FBX)).toEqual({ ext: ".fbx", mime: "application/x-fbx" });
    expect(sniffMediaType(OBJ)).toEqual({ ext: ".obj", mime: "model/obj" });
    expect(sniffMediaType(GLTF)).toEqual({ ext: ".gltf", mime: "model/gltf+json" });
  });

  it("识别 m4a / aac / ogg / flac（不与 mp3 混淆）", () => {
    expect(sniffMediaType(M4A)).toEqual({ ext: ".m4a", mime: "audio/mp4" });
    expect(sniffMediaType(AAC)).toEqual({ ext: ".aac", mime: "audio/aac" });
    expect(sniffMediaType(OGG)).toEqual({ ext: ".ogg", mime: "audio/ogg" });
    expect(sniffMediaType(FLAC)).toEqual({ ext: ".flac", mime: "audio/flac" });
  });

  it("识别压缩包与 PDF", () => {
    expect(sniffMediaType(ZIP)).toEqual({ ext: ".zip", mime: "application/zip" });
    expect(sniffMediaType(GZ)).toEqual({ ext: ".gz", mime: "application/gzip" });
    expect(sniffMediaType(SEVEN_Z)).toEqual({ ext: ".7z", mime: "application/x-7z-compressed" });
    expect(sniffMediaType(RAR)).toEqual({ ext: ".rar", mime: "application/vnd.rar" });
    expect(sniffMediaType(PDF)).toEqual({ ext: ".pdf", mime: "application/pdf" });
  });

  it("无法识别时返回 null（交给上游 CT / URL 兜底）", () => {
    expect(sniffMediaType(Buffer.from("not-a-media"))).toBeNull();
  });
});

describe("saveGeneratedAsset 落桶元数据", () => {
  beforeEach(() => {
    mocks.findFirst.mockResolvedValue({
      id: 1,
      type: "s3",
      endpoint: "https://s3.test",
      bucket: "b",
      accessKey: "ak",
      secretKey: "sk",
      publicBaseUrl: "https://cdn.test",
      isDefault: true,
      enabled: true,
    });
    mocks.create.mockReset();
    mocks.create.mockResolvedValue({ id: 7 });
    mocks.putObject.mockReset();
    mocks.putObject.mockResolvedValue(undefined);
  });

  it("上游给 application/octet-stream 时，PNG 仍落成 .png + image/png", async () => {
    const r = await saveGeneratedAsset({
      userId: 18,
      assetType: "image",
      content: { bytes: PNG, contentType: "application/octet-stream" },
    });

    expect(r.ok).toBe(true);
    const [cfg, key, bytes, mime] = mocks.putObject.mock.calls[0];
    expect(cfg).toEqual({});
    expect(key).toMatch(/^generated\/18\/\d{6}\/[0-9a-f-]{36}\.png$/);
    expect(bytes).toEqual(PNG);
    expect(mime).toBe("image/png");
    expect(mocks.create.mock.calls[0][0].data).toMatchObject({ assetType: "image", mimeType: "image/png" });
  });

  it("JPEG / WebP 同样按魔数纠正", async () => {
    await saveGeneratedAsset({ userId: 18, assetType: "image", content: { bytes: JPEG, contentType: "application/octet-stream" } });
    await saveGeneratedAsset({ userId: 18, assetType: "image", content: { bytes: WEBP, contentType: "application/octet-stream" } });

    expect(mocks.putObject.mock.calls[0][1]).toMatch(/\.jpg$/);
    expect(mocks.putObject.mock.calls[0][3]).toBe("image/jpeg");
    expect(mocks.putObject.mock.calls[1][1]).toMatch(/\.webp$/);
    expect(mocks.putObject.mock.calls[1][3]).toBe("image/webp");
  });

  it("魔数无法识别时保留原有兜底（.bin + 上游 CT）", async () => {
    await saveGeneratedAsset({
      userId: 18,
      assetType: "image",
      content: { bytes: Buffer.from("plain-bytes"), contentType: "application/octet-stream" },
    });

    expect(mocks.putObject.mock.calls[0][1]).toMatch(/\.bin$/);
    expect(mocks.putObject.mock.calls[0][3]).toBe("application/octet-stream");
    // 嗅探不出时不乱填 MIME，保持 NULL
    expect(mocks.create.mock.calls[0][0].data.mimeType).toBeNull();
  });

  it("通用 file 按真实 MIME 升级为 model3d / archive / document", async () => {
    await saveGeneratedAsset({ userId: 18, assetType: "file", content: { bytes: GLB, contentType: "application/octet-stream" } });
    await saveGeneratedAsset({ userId: 18, assetType: "file", content: { bytes: ZIP, contentType: "application/octet-stream" } });
    await saveGeneratedAsset({ userId: 18, assetType: "file", content: { bytes: PDF, contentType: "application/octet-stream" } });

    expect(mocks.create.mock.calls[0][0].data).toMatchObject({ assetType: "model3d", mimeType: "model/gltf-binary" });
    expect(mocks.create.mock.calls[1][0].data).toMatchObject({ assetType: "archive", mimeType: "application/zip" });
    expect(mocks.create.mock.calls[2][0].data).toMatchObject({ assetType: "document", mimeType: "application/pdf" });
    // 扩展名同步纠正
    expect(mocks.putObject.mock.calls[0][1]).toMatch(/\.glb$/);
    expect(mocks.putObject.mock.calls[1][1]).toMatch(/\.zip$/);
    expect(mocks.putObject.mock.calls[2][1]).toMatch(/\.pdf$/);
  });

  it("明确分类不被 MIME 覆盖（audio 仍是 audio，file 才升级）", async () => {
    await saveGeneratedAsset({ userId: 18, assetType: "audio", content: { bytes: M4A, contentType: "application/octet-stream" } });
    expect(mocks.create.mock.calls[0][0].data).toMatchObject({ assetType: "audio", mimeType: "audio/mp4" });
  });
});

describe("backfillAssetMimeTypes 存量回填", () => {
  const bucket = {
    id: 1,
    type: "s3",
    endpoint: "https://s3.test",
    bucket: "b",
    accessKey: "ak",
    secretKey: "sk",
    publicBaseUrl: "https://cdn.test",
    isDefault: true,
    enabled: true,
  };

  beforeEach(() => {
    mocks.getObject.mockReset();
    mocks.assetUpdate.mockReset();
    mocks.assetUpdate.mockResolvedValue({});
  });

  it("按对象字节回填 mimeType，只更新该列；嗅探不出的保持 NULL", async () => {
    mocks.assetFindMany.mockResolvedValue([
      { id: 1n, storageKey: "generated/18/202611/a.bin", bucket },
      { id: 2n, storageKey: "generated/18/202611/b.bin", bucket },
      { id: 3n, storageKey: "generated/18/202611/c.bin", bucket: null },
    ]);
    mocks.getObject
      .mockResolvedValueOnce(JPEG)
      .mockResolvedValueOnce(Buffer.from("unknown-bytes"));

    const r = await backfillAssetMimeTypes(10);

    expect(r).toMatchObject({ scanned: 3, updated: 1, skipped: 2 });
    expect(mocks.assetUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.assetUpdate).toHaveBeenCalledWith({ where: { id: 1n }, data: { mimeType: "image/jpeg" } });
    expect(r.details).toEqual([
      { id: "1", storageKey: "generated/18/202611/a.bin", mime: "image/jpeg" },
      { id: "2", storageKey: "generated/18/202611/b.bin", mime: null },
      { id: "3", storageKey: "generated/18/202611/c.bin", mime: null },
    ]);
  });
});
