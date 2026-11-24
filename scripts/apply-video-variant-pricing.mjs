#!/usr/bin/env node
// ─── 应用 Seedance 2.x 视频档位价 ───
// 数据来源与口径见 prisma/m6-video-variant-pricing-prod.sql 头部注释。
// 本脚本只负责「跑 SQL + 核对」，价格改动请改 SQL 文件，不要在脚本里再抄一份。
//
// 默认 dry-run：在事务里执行后回滚，只打印将要写入/更新的行与抽样核对；
// 加 --apply 才提交。固定 effectiveAt，重复执行不会产生重复行。
//
// 用法：
//   node scripts/apply-video-variant-pricing.mjs [--db postgresql://...] [--apply]
//   连接串默认取 DATABASE_URL。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
const pg = require("pg");

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const APPLY = argv.includes("--apply");
// .env 里的连接串可能带引号，直接丢给 pg 会把 host 解析错，这里先剥掉首尾引号
const dbUrl = (argOf("--db") || process.env.DATABASE_URL || "").replace(/^["']|["']$/g, "");
if (!dbUrl) {
  console.error("缺少数据库连接：--db 或 DATABASE_URL");
  process.exit(2);
}

const EFFECTIVE_AT = "2026-11-17 00:00:00+08";
const EXPECTED_MODELS = [
  "doubao-seedance-2-5-260628",
  "doubao-seedance-2-5-flash-261115",
  "doubao-seedance-2-0-260128",
  "doubao-seedance-2-0-fast-260128",
  "doubao-seedance-2-0-mini-260615",
];
const sqlPath = join(process.cwd(), "prisma", "m6-video-variant-pricing-prod.sql");
const sql = readFileSync(sqlPath, "utf8");

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();

// 折算：积分/秒 = ceil(元/秒 × 166)；N 秒合计 = ceil(元/秒 × 166 × N)
const creditsPerSecond = (price) => Math.max(1, Math.ceil(Number(price) * 166));
const creditsFor = (price, seconds) => Math.max(1, Math.ceil(Number(price) * 166 * seconds));

function report(rows) {
  let lastModel = "";
  for (const r of rows) {
    if (r.name !== lastModel) {
      console.log(`\n${r.name}`);
      lastModel = r.name;
    }
    console.log(
      `  ${r.variant.padEnd(8)} ${String(r.inputPrice).padStart(9)} 元/秒  ` +
        `≈ ${String(creditsPerSecond(r.inputPrice)).padStart(4)} 积分/秒  ` +
        `5s=${String(creditsFor(r.inputPrice, 5)).padStart(5)} 积分  ` +
        `[${r.unit} ×${r.multiplierBps / 10000}]`
    );
  }
}

const { rows: models } = await client.query(
  `SELECT id, name FROM ai_model WHERE "vendorId" = 3 AND name = ANY($1) ORDER BY name`,
  [EXPECTED_MODELS]
);
const missing = EXPECTED_MODELS.filter((n) => !models.some((m) => m.name === n));
if (missing.length > 0) {
  console.error("目标模型缺失，已中止（不写库）：", missing.join(", "));
  await client.end();
  process.exit(3);
}

console.log(`SQL：${sqlPath}`);
console.log(`目标模型：${models.length} 个；生效时间：${EFFECTIVE_AT}`);

for (const phase of APPLY ? ["apply"] : ["dry-run"]) {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    const { rows } = await client.query(
      `SELECT m.name, p.variant, p."inputPrice", p."outputPrice", p.unit,
              p."multiplierBps", p."meterBase", p."effectiveAt"
         FROM model_pricing p
         JOIN ai_model m ON m.id = p."modelId"
        WHERE m."vendorId" = 3
          AND p."effectiveAt" = $1::timestamptz
        ORDER BY m.name, p.variant`,
      [EFFECTIVE_AT]
    );
    console.log(`\n=== 档位价（${rows.length} 行，预期 28）===`);
    report(rows);

    if (rows.length !== 28) {
      throw new Error(`档位行数 ${rows.length} ≠ 预期 28，已中止`);
    }
    const expectedPerModel = {
      "doubao-seedance-2-5-260628": 8,
      "doubao-seedance-2-5-flash-261115": 4,
      "doubao-seedance-2-0-260128": 8,
      "doubao-seedance-2-0-fast-260128": 4,
      "doubao-seedance-2-0-mini-260615": 4,
    };
    const perModel = new Map();
    for (const r of rows) perModel.set(r.name, (perModel.get(r.name) || 0) + 1);
    const wrong = [...perModel.entries()].filter(
      ([name, n]) => n !== expectedPerModel[name]
    );
    if (wrong.length > 0) {
      throw new Error(`模型档位数量异常：${JSON.stringify(wrong)}`);
    }

    if (phase === "dry-run") {
      await client.query("ROLLBACK");
      console.log("\n[dry-run] 已回滚，未写库。确认后加 --apply 执行。");
    } else {
      await client.query("COMMIT");
      console.log("\n[apply] 已提交。重复执行不会新增行（同 modelId+variant+effectiveAt 走更新）。");
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\n执行失败，已回滚：", e.message);
    await client.end();
    process.exit(1);
  }
}

await client.end();
