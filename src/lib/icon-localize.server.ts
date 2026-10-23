import "server-only";

import { writeFile, mkdir } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { sniffKind } from "./upload-core.server";

// 软件图标自动本地化：外链图标抓取 → 魔数校验 → 落盘 public/uploads/icons/
// 全站禁止站外资源链接，保存软件时对外链图标调用本函数转换为站内路径。

const EXT: Record<string, string> = { jpg: ".jpg", png: ".png", webp: ".webp", gif: ".gif" };
const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT = 10_000;

/** 已是站内路径则原样返回；外链抓取本地化；失败返回 null（不阻塞保存，图标留空） */
export async function localizeIcon(icon: string | null | undefined): Promise<string | null> {
  if (!icon) return null;
  const v = icon.trim();
  if (!v) return null;
  if (v.startsWith("/")) return v; // 站内路径（本地上传已落盘）
  if (!/^https?:\/\//i.test(v)) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const res = await fetch(v, {
      signal: controller.signal,
      headers: { "User-Agent": "IcebergAI-IconFetcher/1.0", Referer: v },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 12 || buf.length > MAX_BYTES) return null;
    const kind = sniffKind(buf);
    if (!kind || !EXT[kind]) return null; // 仅收图片（拒绝 svg/ico，防止脚本注入）

    const dir = path.join(process.cwd(), "public", "uploads", "icons");
    await mkdir(dir, { recursive: true });
    const name = `icon-${crypto.createHash("md5").update(v).digest("hex").slice(0, 12)}${EXT[kind]}`;
    await writeFile(path.join(dir, name), buf);
    return `/uploads/icons/${name}`;
  } catch {
    return null;
  }
}
