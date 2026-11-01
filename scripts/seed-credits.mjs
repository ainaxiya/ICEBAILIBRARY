// P2 积分包种子数据（幂等 upsert，不覆盖后台已改的字段）
// 用法：DATABASE_URL 指向本地库执行  node scripts/seed-credits.mjs
// 安全阀：拒绝指向 35432（生产隧道端口），防止误写生产库
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL || "";
if (url.includes(":35432")) {
  console.error("[seed-credits] 拒绝执行：DATABASE_URL 指向 35432（生产库），请用环境变量覆盖到本地 5432");
  process.exit(1);
}

const PACKS = [
  { packCode: "p30", priceCents: 3000n, credits: 3000n, sortOrder: 1 },
  { packCode: "p50", priceCents: 5000n, credits: 5100n, sortOrder: 2 },
  { packCode: "p200", priceCents: 20000n, credits: 22500n, sortOrder: 3 },
];

const db = new PrismaClient();
try {
  for (const p of PACKS) {
    const row = await db.creditPack.upsert({
      where: { packCode: p.packCode },
      update: {},
      create: { ...p, isActive: true },
    });
    console.log(`[seed-credits] ${row.packCode}: ${row.priceCents} 分 -> ${row.credits} 积分`);
  }
  console.log("[seed-credits] done");
} finally {
  await db.$disconnect();
}
