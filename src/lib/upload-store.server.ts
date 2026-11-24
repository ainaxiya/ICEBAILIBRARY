import "server-only";

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeUploadName, normalizeExt, uploadMonth, type UploadKind } from "./upload-naming";

// ─── 全站上传产物落盘唯一入口 ───
// 统一结构：public/uploads/<YYYY-MM>/<类型名>-<时间刻度>-<随机12位>.<ext>
// 月份与文件名均由服务端生成，不接受任何用户输入参与路径拼接；
// 写入用 wx 独占创建，撞名自动重新生成，绝不覆盖已有文件。

export const UPLOADS_ROOT = path.join(process.cwd(), "public", "uploads");

export interface StoredUpload {
  /** 对外访问路径 /uploads/YYYY-MM/xxx.webp */
  url: string;
  /** 文件名（不含目录） */
  name: string;
  /** 绝对落盘路径 */
  filePath: string;
  /** 月份目录 YYYY-MM */
  month: string;
}

// 防穿越：月份目录必须正好是 uploads 根下的一级目录
function monthDir(now: Date): { month: string; dir: string } {
  const month = uploadMonth(now);
  const root = path.resolve(UPLOADS_ROOT);
  const dir = path.resolve(root, month);
  if (path.relative(root, dir) !== month) {
    throw new Error("[upload] invalid month dir");
  }
  return { month, dir };
}

// 防穿越：文件名必须是目录内的单层文件名
function ensureSafeTarget(dir: string, filePath: string): string {
  const rel = path.relative(dir, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) {
    throw new Error("[upload] invalid file path");
  }
  return filePath;
}

/** 分配一个不冲突的落盘路径（不创建文件） */
export function allocateUpload(kind: UploadKind, ext: string, now: Date = new Date()): StoredUpload {
  const e = normalizeExt(ext);
  const { month, dir } = monthDir(now);
  for (let i = 0; i < 20; i++) {
    const name = makeUploadName(kind, e);
    const filePath = ensureSafeTarget(dir, path.join(dir, name));
    if (!existsSync(filePath)) {
      return { url: `/uploads/${month}/${name}`, name, filePath, month };
    }
  }
  throw new Error("[upload] name collision retry exhausted");
}

/** 写入字节到月份目录；wx 独占创建，撞名重新生成 */
export async function saveUpload(
  kind: UploadKind,
  ext: string,
  bytes: Buffer
): Promise<StoredUpload> {
  const e = normalizeExt(ext);
  const { month, dir } = monthDir(new Date());
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < 20; i++) {
    const name = makeUploadName(kind, e);
    const filePath = ensureSafeTarget(dir, path.join(dir, name));
    try {
      await writeFile(filePath, bytes, { flag: "wx" });
      return { url: `/uploads/${month}/${name}`, name, filePath, month };
    } catch (err: any) {
      if (err?.code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("[upload] name collision retry exhausted");
}

/** 同步写入（采集等同步链路使用） */
export function saveUploadSync(kind: UploadKind, ext: string, bytes: Buffer): StoredUpload {
  const e = normalizeExt(ext);
  const { month, dir } = monthDir(new Date());
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 20; i++) {
    const name = makeUploadName(kind, e);
    const filePath = ensureSafeTarget(dir, path.join(dir, name));
    try {
      writeFileSync(filePath, bytes, { flag: "wx" });
      return { url: `/uploads/${month}/${name}`, name, filePath, month };
    } catch (err: any) {
      if (err?.code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("[upload] name collision retry exhausted");
}

/** 把已下载好的临时文件原子移动到月份目录 */
export async function commitUploadFromTemp(
  tmpPath: string,
  kind: UploadKind,
  ext: string
): Promise<StoredUpload> {
  const target = allocateUpload(kind, ext);
  await mkdir(path.dirname(target.filePath), { recursive: true });
  await rename(tmpPath, target.filePath);
  return target;
}

/** /uploads/YYYY-MM/x.webp → 磁盘路径（用于校验旧文件是否还在） */
export function uploadUrlToPath(url: string): string | null {
  if (!url.startsWith("/uploads/")) return null;
  const rel = url.slice("/uploads/".length);
  const root = path.resolve(UPLOADS_ROOT);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) return null;
  return abs;
}
