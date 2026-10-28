// 一次性刷次数脚本（不进系统功能，只跑一次；跑完可删）
//   技能 Skill：viewCount / copyCount / downloadCount 各 +20~2000 随机
//   提示词 Prompt：viewCount +50~1500 随机
// 同时把 updatedAt 刷为 now()，让 Meili 同步守护进程把新计数推到搜索索引。
// 用法：node scripts/bump-counts.mjs          # dry-run，只看影响范围
//       node scripts/bump-counts.mjs --run    # 真正执行
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const db = new PrismaClient();
const RUN = process.argv.includes("--run");

async function sample(table, cols) {
  return db.$queryRawUnsafe(
    `SELECT id, ${cols.map((c) => `"${c}"`).join(", ")} FROM "${table}" ORDER BY random() LIMIT 5`
  );
}

async function main() {
  const skillCount = await db.skill.count();
  const promptCount = await db.prompt.count();
  console.log(`影响范围：Skill ${skillCount} 条（查看/复制/下载各 +20~2000），Prompt ${promptCount} 条（查看 +50~1500）`);
  console.log("\n刷前抽样 Skill:", await sample("Skill", ["viewCount", "copyCount", "downloadCount"]));
  console.log("刷前抽样 Prompt:", await sample("Prompt", ["viewCount"]));

  if (!RUN) {
    console.log("\n[dry-run] 未执行。加 --run 真正刷数。");
    return;
  }

  const s = await db.$executeRawUnsafe(`
    UPDATE "Skill" SET
      "viewCount"     = "viewCount"     + (20 + floor(random() * 1981))::int,
      "copyCount"     = "copyCount"     + (20 + floor(random() * 1981))::int,
      "downloadCount" = "downloadCount" + (20 + floor(random() * 1981))::int,
      "updatedAt"     = now()
  `);
  const p = await db.$executeRawUnsafe(`
    UPDATE "Prompt" SET
      "viewCount" = "viewCount" + (50 + floor(random() * 1451))::int,
      "updatedAt" = now()
  `);
  console.log(`\n已刷：Skill ${s} 条，Prompt ${p} 条`);
  console.log("刷后抽样 Skill:", await sample("Skill", ["viewCount", "copyCount", "downloadCount"]));
  console.log("刷后抽样 Prompt:", await sample("Prompt", ["viewCount"]));
  console.log("Meili 同步守护进程会在下个周期把新计数推到搜索索引。");
}

main()
  .catch((e) => {
    console.error("失败:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
