import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { removeLocalMediaFiles } from "@/lib/playground/media-task-runner";

// ─── p6 收尾：任务终态清理只删行不删文件 → 本地产物文件一并删除 ───

const MONTH = "2026-11";
const dir = path.join(process.cwd(), "public", "uploads", MONTH);
const created: string[] = [];

function makeLocalFile(name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, "unit-test");
  created.push(file);
  return file;
}

afterAll(() => {
  for (const f of created) if (existsSync(f)) rmSync(f, { force: true });
});

describe("removeLocalMediaFiles", () => {
  it("删除符合本地命名的产物文件", () => {
    const file = makeLocalFile("image-1795000000000-AbCdEf123456.mp4");
    const url = `/uploads/${MONTH}/image-1795000000000-AbCdEf123456.mp4`;

    removeLocalMediaFiles(JSON.stringify([url]));

    expect(existsSync(file)).toBe(false);
  });

  it("桶外链、头像等非本地产物路径不动", () => {
    const avatar = path.join(dir, "avatars", "keep.webp");
    mkdirSync(path.dirname(avatar), { recursive: true });
    writeFileSync(avatar, "keep");

    removeLocalMediaFiles(
      JSON.stringify([
        "https://cdn.test.local/generated/18/202611/x.bin",
        "/uploads/avatars/keep.webp",
        "/site-assets/logo-mono.png",
        "../../etc/passwd",
        "/uploads/2026-11/image-1795000000000-AbCdEf123456.webp/../x",
      ])
    );

    expect(existsSync(avatar)).toBe(true);
    rmSync(avatar, { force: true });
  });

  it("null / 非法 JSON / 非数组不抛错", () => {
    expect(() => removeLocalMediaFiles(null)).not.toThrow();
    expect(() => removeLocalMediaFiles("not-json")).not.toThrow();
    expect(() => removeLocalMediaFiles(JSON.stringify({ a: 1 }))).not.toThrow();
  });
});
