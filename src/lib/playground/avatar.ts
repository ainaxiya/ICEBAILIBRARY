// ─── 实验场虚拟角色头像 ───
// 存 SiteSetting key="playground_avatar"（重启不丢）。
// 存储沿用后台上传规则：默认桶已配置（且有公开访问域名）→ 进默认桶；否则落本地 public/site-assets。
import crypto from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { bucketToConfig, putObject } from "@/lib/s3";

export const PLAYGROUND_AVATAR_KEY = "playground_avatar";

// 默认虚拟角色形象：直接复用积分不足页的角色插画（public/site-assets，905×718 WebP，约 219KB）
// 原图为半身构图，前台以小尺寸头像展示时按脸部区域放大裁切（见 PlaygroundChat 的 background-size/position）。
export const DEFAULT_PLAYGROUND_AVATAR = "/site-assets/points-page/lihuahua.webp";

export interface PlaygroundAvatar {
  url: string | null;
  isDefault: boolean;
  storage: "local" | "bucket" | null;
  key: string | null;
  updatedAt: string | null;
}

const EMPTY: PlaygroundAvatar = {
  url: DEFAULT_PLAYGROUND_AVATAR,
  isDefault: true,
  storage: null,
  key: null,
  updatedAt: null,
};

export async function getPlaygroundAvatar(): Promise<PlaygroundAvatar> {
  try {
    const row = await db.siteSetting.findUnique({ where: { key: PLAYGROUND_AVATAR_KEY } });
    if (!row) return EMPTY;
    const p = JSON.parse(row.value) as Partial<PlaygroundAvatar>;
    if (typeof p.url !== "string" || !p.url) return EMPTY;
    return {
      url: p.url,
      isDefault: false,
      storage: p.storage === "bucket" ? "bucket" : "local",
      key: typeof p.key === "string" ? p.key : null,
      updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null,
    };
  } catch {
    return EMPTY;
  }
}

export interface SavedAvatar {
  url: string;
  storage: "local" | "bucket";
  key: string;
}

function extOfMime(mime: string): string {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  return ".webp";
}

// 优先级：默认桶（公开读）→ 本地 public/site-assets
export async function savePlaygroundAvatar(bytes: Buffer, mime: string): Promise<SavedAvatar> {
  const ext = extOfMime(mime);
  const bucket = await db.storageBucket.findFirst({
    where: { isDefault: true, enabled: true },
    orderBy: { id: "asc" },
  });

  let saved: SavedAvatar;
  if (bucket && bucket.publicBaseUrl) {
    const key = `playground/avatar/${crypto.randomUUID()}${ext}`;
    await putObject(bucketToConfig(bucket), key, bytes, mime);
    saved = {
      url: `${bucket.publicBaseUrl.replace(/\/+$/, "")}/${key}`,
      storage: "bucket",
      key,
    };
  } else {
    const name = `playground-avatar-${Date.now()}${ext}`;
    const dir = path.join(process.cwd(), "public", "site-assets");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), bytes);
    saved = { url: `/site-assets/${name}`, storage: "local", key: name };
  }

  const value: PlaygroundAvatar = { ...saved, isDefault: false, updatedAt: new Date().toISOString() };
  await db.siteSetting.upsert({
    where: { key: PLAYGROUND_AVATAR_KEY },
    update: { value: JSON.stringify(value) },
    create: { key: PLAYGROUND_AVATAR_KEY, value: JSON.stringify(value) },
  });
  return saved;
}

export async function clearPlaygroundAvatar(): Promise<void> {
  await db.siteSetting.deleteMany({ where: { key: PLAYGROUND_AVATAR_KEY } });
}
