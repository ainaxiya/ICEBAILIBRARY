import { describe, expect, it } from "vitest";
import {
  ASSET_TYPES,
  assetTypeFromMime,
  assetTypeIcon,
  assetTypeLabel,
  refineAssetType,
} from "@/lib/asset-types";

// 资产分类口径：取值铺全、每个取值都有中文名与图标，
// MIME 能推断时落具体分类，历史/未知值不抛错。
describe("资产分类口径", () => {
  it("每个 assetType 都有中文名与图标（不落 default 空显示）", () => {
    for (const t of ASSET_TYPES) {
      expect(assetTypeLabel(t)).not.toBe(t);
      expect(assetTypeIcon(t)).not.toBe("");
    }
  });

  it("历史 / 未知值可读：label 原样返回、icon 用通用兜底", () => {
    expect(assetTypeLabel("legacy-type")).toBe("legacy-type");
    expect(assetTypeIcon("legacy-type")).toBe("📄");
    expect(assetTypeLabel("file")).toBe("文件");
  });

  it("新增分类齐全：speech / music / sfx / model3d / document / archive 等", () => {
    for (const t of ["image", "video", "audio", "speech", "music", "sfx", "model3d", "text", "document", "archive", "other"]) {
      expect(ASSET_TYPES).toContain(t);
    }
  });

  it("MIME → 分类映射覆盖 3D / 音频 / 文档 / 压缩包", () => {
    expect(assetTypeFromMime("model/gltf-binary")).toBe("model3d");
    expect(assetTypeFromMime("model/gltf+json")).toBe("model3d");
    expect(assetTypeFromMime("model/obj")).toBe("model3d");
    expect(assetTypeFromMime("application/x-fbx")).toBe("model3d");
    expect(assetTypeFromMime("audio/mp4")).toBe("audio");
    expect(assetTypeFromMime("audio/flac")).toBe("audio");
    expect(assetTypeFromMime("application/pdf")).toBe("document");
    expect(assetTypeFromMime("application/zip")).toBe("archive");
    expect(assetTypeFromMime("application/x-7z-compressed")).toBe("archive");
    expect(assetTypeFromMime("text/plain")).toBe("text");
    expect(assetTypeFromMime("application/octet-stream")).toBeNull();
    expect(assetTypeFromMime(null)).toBeNull();
  });

  it("refineAssetType 只升级笼统 file，不覆盖明确分类", () => {
    expect(refineAssetType("file", "model/gltf-binary")).toBe("model3d");
    expect(refineAssetType("file", null)).toBe("file");
    expect(refineAssetType("speech", "audio/mpeg")).toBe("speech");
    expect(refineAssetType("image", "image/png")).toBe("image");
  });
});
