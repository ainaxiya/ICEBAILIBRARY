import "server-only";

import { accessSync, constants, mkdirSync } from "node:fs";
import path from "node:path";

// ─── 项目内临时目录 ───
// 不再使用系统 /tmp：线上 /tmp 为 root:root 755，服务进程 www 不可写，
// 采集下载/截帧、转码中转都会 EACCES。默认落在项目根 tmp/，运行时按需创建；
// 可用 APP_TMP_DIR 覆盖。清理由运维工具负责，代码里不做定时删除/启动清空。
export const APP_TMP_DIR = process.env.APP_TMP_DIR
  ? path.resolve(process.env.APP_TMP_DIR)
  : path.join(process.cwd(), "tmp");

let ready = false;

/** 确保临时目录存在且当前进程可写；失败抛出带绝对路径与错误码的明确错误 */
export function ensureTmpDir(): string {
  if (ready) return APP_TMP_DIR;
  try {
    mkdirSync(APP_TMP_DIR, { recursive: true });
    accessSync(APP_TMP_DIR, constants.W_OK);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new Error(
      `临时目录不可用：${APP_TMP_DIR}（${err.code || err.name || "ERROR"}: ${err.message}）。` +
        "请确认目录存在且运行用户可写，或用 APP_TMP_DIR 指定其它目录。"
    );
  }
  ready = true;
  return APP_TMP_DIR;
}

/** 项目内临时文件绝对路径（调用前会确保目录可用） */
export function tmpPath(name: string): string {
  return path.join(ensureTmpDir(), name);
}
