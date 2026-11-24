// 等级表种子 + 存量账号回填（幂等，可重复执行）
//   node scripts/seed-membership-levels.mjs
// 连接串优先 .env.local，其次 DATABASE_URL。
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

function pickUrl() {
  const f = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(f)) {
    const m = fs.readFileSync(f, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
    if (m) return m[1];
  }
  return process.env.DATABASE_URL;
}

const LEVELS = [
  { code: "free", name: "普通会员", isSystem: false, canLogin: true, isDefault: true, grantCondition: "注册自动获得", sortOrder: 10 },
  { code: "pro", name: "专业会员", isSystem: false, canLogin: true, isDefault: false, grantCondition: "后台授予（暂不启用售卖）", sortOrder: 20 },
  { code: "vip", name: "高级会员", isSystem: false, canLogin: true, isDefault: false, grantCondition: "后台授予（暂不启用售卖）", sortOrder: 30 },
  { code: "importer", name: "采集系统", isSystem: true, canLogin: false, isDefault: false, grantCondition: "采集任务自动创建", sortOrder: 90 },
];

const prisma = new PrismaClient({ datasources: { db: { url: pickUrl() } } });

// 只补缺失，不覆盖后台改过的名称/文案
for (const l of LEVELS) {
  await prisma.membershipLevel.upsert({
    where: { code: l.code },
    update: {},
    create: l,
  });
}

// 数据库层兜底：默认等级全表唯一
await prisma.$executeRawUnsafe(`
  CREATE UNIQUE INDEX IF NOT EXISTS "membership_level_one_default"
  ON "membership_level" (("isDefault")) WHERE "isDefault" = true
`);

const levels = await prisma.membershipLevel.findMany({ orderBy: { sortOrder: "asc" } });
const dist = await prisma.$queryRawUnsafe(
  `SELECT "membershipLevel" AS level, COUNT(*)::int AS cnt FROM "User" GROUP BY 1 ORDER BY 1`
);
const orphans = await prisma.$queryRawUnsafe(
  `SELECT u.id, u.username, u."membershipLevel" FROM "User" u
   LEFT JOIN "membership_level" l ON l."code" = u."membershipLevel"
   WHERE l."code" IS NULL`
);

console.log("LEVELS=" + levels.map((l) => `${l.code}(${l.name},system=${l.isSystem},login=${l.canLogin},default=${l.isDefault})`).join(" | "));
console.log("USER_DIST=" + JSON.stringify(dist));
console.log("ORPHANS=" + JSON.stringify(orphans));
await prisma.$disconnect();
