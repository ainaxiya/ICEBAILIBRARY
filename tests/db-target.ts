// ─── 测试库目标解析（纯解析，不做任何初始化）───
// 优先级：TEST_DATABASE_URL（完整测试库连接串）> DATABASE_URL 环境变量 > .env.local > .env
// 测试库名 = 基础库名 + "_test"（icebaidata → icebaidata_test），与开发库/线上数据副本隔离。
// 安全闸：只允许本机 127.0.0.1/localhost，且拒绝 35432（生产隧道端口）。
// 注意：Prisma 会自行加载 .env，可能把生产连接串塞进 process.env.DATABASE_URL，
// 因此每个候选都要过安全闸，命中生产配置就跳过、回退到本地 env 文件。
import fs from "node:fs";
import path from "node:path";

function readEnvFile(name: string): Record<string, string> {
  const p = path.join(process.cwd(), name);
  if (!fs.existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

// .env.local 后加载，优先级高于 .env（与 Next.js 一致）
const fileEnv = { ...readEnvFile(".env"), ...readEnvFile(".env.local") };

const explicitTestUrl = (process.env.TEST_DATABASE_URL || "").trim();
const candidates = [
  { label: "TEST_DATABASE_URL", url: explicitTestUrl },
  { label: "环境变量 DATABASE_URL", url: (process.env.DATABASE_URL || "").trim() },
  { label: ".env.local / .env", url: (fileEnv.DATABASE_URL || "").trim() },
].filter((c) => c.url);

if (!candidates.length) {
  throw new Error("未找到数据库连接串：请设置 TEST_DATABASE_URL，或在 .env.local / .env 里配置 DATABASE_URL");
}

function parse(c: { label: string; url: string }): { url: URL; host: string; port: string; dbName: string } {
  const u = new URL(c.url);
  const host = u.hostname;
  const port = u.port || "5432";
  const dbName = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!["127.0.0.1", "localhost"].includes(host) || port === "35432") {
    throw new Error(`${c.label} 指向非本地/疑似生产库（${host}:${port}），已跳过`);
  }
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
    throw new Error(`${c.label} 的数据库名非法（只允许字母/数字/下划线）：${dbName}`);
  }
  return { url: u, host, port, dbName };
}

let picked: { label: string; url: URL; host: string; port: string; dbName: string } | null = null;
const rejected: string[] = [];
for (const c of candidates) {
  try {
    picked = { label: c.label, ...parse(c) };
    break;
  } catch (e) {
    rejected.push((e as Error).message);
  }
}
if (!picked) {
  throw new Error(`没有可用于测试的本地数据库连接串：\n  ${rejected.join("\n  ")}`);
}

const base = picked.url;
const dbHost = picked.host;
const dbPort = picked.port;

// 显式给了 TEST_DATABASE_URL 就按原样用；否则派生 `<基础库名>_test`
const testDbName =
  picked.label === "TEST_DATABASE_URL"
    ? picked.dbName
    : picked.dbName.endsWith("_test")
      ? picked.dbName
      : `${picked.dbName}_test`;

function withDbName(name: string): string {
  const u = new URL(base.toString());
  u.pathname = `/${name}`;
  return u.toString();
}

export const TEST_DB_NAME = testDbName;
export const BASE_DB_URL = base.toString();
export const TEST_DB_URL = withDbName(testDbName);
export const ADMIN_DB_URL = withDbName("postgres");
