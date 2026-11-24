import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
// db-target 必须先于 @prisma/client 求值：Prisma 会自行加载 .env，
// 若先加载会把 .env 里的生产连接串写进 process.env.DATABASE_URL
import { ADMIN_DB_URL, TEST_DB_NAME, TEST_DB_URL } from "./db-target";
import { PrismaClient } from "@prisma/client";

export { ADMIN_DB_URL, TEST_DB_NAME, TEST_DB_URL };

let ready: Promise<void> | null = null;

// 测试库准备（幂等、只增不删）：
//   1) 测试库不存在 → CREATE DATABASE（空库，不复制任何数据）
//   2) prisma db push 同步 schema（仅作用于 <基础库名>_test）
// 绝不做：删除/重建数据目录、initdb、启动 PG 实例、占用 5432、清空基础库数据。
export function ensureTestDb(): Promise<void> {
  if (!ready) ready = prepare();
  return ready;
}

async function prepare(): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_DB_URL } } });
  try {
    const rows = await admin.$queryRawUnsafe<{ datname: string }[]>(
      `SELECT datname FROM pg_database WHERE datname = $1`,
      TEST_DB_NAME
    );
    if (!rows.length) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${TEST_DB_NAME}" ENCODING 'UTF8' TEMPLATE template0`);
      console.log(`[test-db] 已创建测试库 ${TEST_DB_NAME}`);
    }
  } finally {
    await admin.$disconnect();
  }

  // 直接用 node 执行 prisma CLI：不经 shell，不产生 cmd.exe 窗口
  const prismaCli = path.join(process.cwd(), "node_modules", "prisma", "build", "index.js");
  if (!fs.existsSync(prismaCli)) {
    throw new Error(`找不到 prisma CLI：${prismaCli}（请先在项目根执行 npm install）`);
  }
  const runPush = () =>
    spawnSync(process.execPath, [prismaCli, "db", "push", "--skip-generate", "--accept-data-loss"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: "pipe",
      windowsHide: true,
    });

  let r = runPush();
  if (r.status !== 0) {
    // 存量测试库首次加 User→membership_level 外键时：push 会先建空等级表再因存量 User 犯规失败。
    // 此时先补等级种子，再重试一次 push（幂等）。
    await seedLevels();
    r = runPush();
  }
  if (r.status !== 0) {
    const tail = `${r.stdout?.toString() ?? ""}\n${r.stderr?.toString() ?? ""}`
      .trim()
      .split(/\r?\n/)
      .slice(-8)
      .join("\n");
    throw new Error(`prisma db push 失败（${TEST_DB_NAME}）：\n${tail}`);
  }

  // 等级表种子（User.membershipLevel 是外键，测试库必须至少有 free/importer）
  await seedLevels();
}

// 等级种子：等级表尚未创建时静默跳过（首次 push 会创建它）
async function seedLevels(): Promise<void> {
  const seeded = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
  try {
    const exists = await seeded.$queryRawUnsafe<{ t: string | null }[]>(
      `SELECT to_regclass('"membership_level"')::text AS t`
    );
    if (!exists[0]?.t) return;
    await seeded.$executeRawUnsafe(`
      INSERT INTO "membership_level"
        ("code","name","isSystem","canLogin","isDefault","grantCondition","sortOrder","isActive","createdAt","updatedAt")
      VALUES
        ('free','普通会员',false,true,true,'注册自动获得',10,true,now(),now()),
        ('pro','专业会员',false,true,false,'后台授予（暂不启用售卖）',20,true,now(),now()),
        ('vip','高级会员',false,true,false,'后台授予（暂不启用售卖）',30,true,now(),now()),
        ('importer','采集系统',true,false,false,'采集任务自动创建',90,true,now(),now())
      ON CONFLICT ("code") DO NOTHING
    `);
  } finally {
    await seeded.$disconnect();
  }
}
