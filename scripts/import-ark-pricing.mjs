#!/usr/bin/env node
// ─── 火山方舟（Ark）报价表导入 model_pricing ───
// 口径（与用户确认）：
//   1) 报价表「API模型ID」= 后台模型名（ai_model.name），只按它匹配，不用显示名/中文名；
//   2) 只填已入库的模型，表里有、库里没有的跳过，不新建模型；
//   3) 已开通（Available）才导入；未开通（Unavailable）跳过；
//   4) 计费模式/货币取表内「计价单位」「币种」；
//   5) 加价系数统一 1.66（multiplierBps=16600）；
//   6) 千tokens → unit=token / meterBase=1000；张 → unit=image / meterBase=1。
//
// 默认 dry-run（只读，只打印报告）；加 --apply 才写库。
// 用法：
//   node scripts/import-ark-pricing.mjs --csv /tmp/ark.csv [--vendor 火山] [--overwrite] [--apply]
// 连接串取 DATABASE_URL，或 --db postgresql://...
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// 依赖从当前工作目录（项目根）解析：本地在仓库根执行，线上脚本在 /tmp 但 cwd 是应用目录
const require = createRequire(join(process.cwd(), "package.json"));
const pg = require("pg");

// ── 参数 ──
const argv = process.argv.slice(2);
const argOf = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const hasFlag = (name) => argv.includes(name);
const CSV_PATH = argOf("--csv");
const VENDOR_HINT = argOf("--vendor", "火山");
const OVERWRITE = hasFlag("--overwrite");
const APPLY = hasFlag("--apply");
const MULTIPLIER_BPS = 16600;
if (!CSV_PATH) {
  console.error("缺少 --csv <报价表路径>");
  process.exit(2);
}

// ── 极简 CSV 解析（支持双引号包裹与转义）──
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }
  return rows;
}

// ── 报价表结构 ──
const csvRows = parseCsv(readFileSync(CSV_PATH, "utf8"));
const header = csvRows[0].map((h) => h.trim());
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`报价表缺少列：${name}（实际列：${header.join(",")}）`);
  return i;
};
const C = {
  apiModelId: col("API模型ID"),
  modelName: col("模型名称"),
  modelId: col("模型ID"),
  vendor: col("厂商"),
  state: col("开通状态"),
  item: col("计费项"),
  itemKey: col("计费项标识"),
  price: col("单价(元)"),
  unit: col("计价单位"),
  currency: col("币种"),
};

/** API模型ID → { name, modelId, vendor, state, items:[{key,item,price,unit,currency}] } */
const arkModels = new Map();
for (const r of csvRows.slice(1)) {
  const id = (r[C.apiModelId] || "").trim();
  if (!id) continue;
  if (!arkModels.has(id)) {
    arkModels.set(id, {
      id,
      name: (r[C.modelName] || "").trim(),
      modelId: (r[C.modelId] || "").trim(),
      vendor: (r[C.vendor] || "").trim(),
      state: (r[C.state] || "").trim(),
      rows: [],
    });
  }
  arkModels.get(id).rows.push({
    key: (r[C.itemKey] || "").trim(),
    item: (r[C.item] || "").trim(),
    price: Number((r[C.price] || "").trim()),
    unit: (r[C.unit] || "").trim(),
    currency: (r[C.currency] || "").trim(),
  });
}

// ── 单价选取规则（同一模型可能有 Fast/Flex/Batch/分层等多档，取标准档）──
const INPUT_KEYS = ["InferencePrompt", "VisionPrompt", "T2IPrompt", "I2IPrompt", "InpaintingPrompt", "ToIPrompt"];
const OUTPUT_KEYS = ["InferenceCompletion", "VisionCompletion", "T2ICompletion", "I2ICompletion", "InpaintingCompletion", "ToICompletion"];
const pick = (rows, keys, unit) => {
  for (const k of keys) {
    const hit = rows.find((r) => r.key === k && r.unit === unit && Number.isFinite(r.price));
    if (hit) return hit;
  }
  return null;
};

// 计价单位 → { unit, meterBase }；不认识的返回 null（跳过）
const UNIT_MAP = {
  千tokens: { unit: "token", meterBase: 1000 },
  tokens: { unit: "token", meterBase: 1 },
  百万tokens: { unit: "token", meterBase: 1000000 },
  张: { unit: "image", meterBase: 1 },
  秒: { unit: "video_second", meterBase: 1 },
  次: { unit: "request", meterBase: 1 },
};

// 3D / 视频生成家族（主站目前没有对应计费端点或其计量口径与报价表不一致）
const is3D = (id) => /seed3d|hyper3d|hitem3d/i.test(id);
const isVideo = (id, endpointType) =>
  endpointType === "video" || /seedance|video|i2v|t2v|r2v/i.test(id);

// ── 连接数据库 ──
const dbUrl = argOf("--db") || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("缺少数据库连接：--db 或 DATABASE_URL");
  process.exit(2);
}
const client = new pg.Client({ connectionString: dbUrl });
await client.connect();

const vendors = (await client.query(`SELECT id, name FROM ai_vendor ORDER BY id`)).rows;
const vendor =
  vendors.find((v) => v.name.includes(VENDOR_HINT)) ||
  vendors.find((v) => new RegExp(VENDOR_HINT, "i").test(v.name));
if (!vendor) {
  console.error(`未找到名称含「${VENDOR_HINT}」的厂商，现有：`, vendors.map((v) => v.name).join(" / "));
  await client.end();
  process.exit(3);
}

const dbModels = (
  await client.query(
    `SELECT m.id, m.name, m."displayName", m."endpointType", m.status,
            (SELECT count(*)::int FROM model_pricing p WHERE p."modelId" = m.id) AS pricing_count
     FROM ai_model m WHERE m."vendorId" = $1 ORDER BY m.name`,
    [vendor.id]
  )
).rows;
const dbByName = new Map(dbModels.map((m) => [m.name, m]));

// ── 逐条生成计划 ──
const ok = []; // 可写入
const skipped = []; // 表内模型跳过
for (const [apiId, m] of arkModels) {
  const dbModel = dbByName.get(apiId);
  if (!dbModel) {
    skipped.push({ id: apiId, name: m.name, reason: "未入库（表中有、库里没有）" });
    continue;
  }
  if (m.state !== "已开通") {
    skipped.push({ id: apiId, name: m.name, reason: `上游未开通（${m.state || "Unknown"}）` });
    continue;
  }
  if (is3D(apiId)) {
    skipped.push({ id: apiId, name: m.name, reason: "3D 生成模型，主站无 3D 计费端点" });
    continue;
  }
  if (isVideo(apiId, dbModel.endpointType)) {
    skipped.push({ id: apiId, name: m.name, reason: "视频按 token 计价，主站按秒计费，口径不一致（待确认）" });
    continue;
  }

  // 计费单位：文本类用千tokens 行；图片类用「张」行
  const unitSet = [...new Set(m.rows.map((r) => r.unit))];
  let billingUnit = null;
  let inputRow = null;
  let outputRow = null;
  if (unitSet.includes("千tokens")) {
    billingUnit = "千tokens";
    inputRow = pick(m.rows, INPUT_KEYS, "千tokens");
    outputRow = pick(m.rows, OUTPUT_KEYS, "千tokens");
  } else if (unitSet.includes("张")) {
    billingUnit = "张";
    inputRow = pick(m.rows, INPUT_KEYS, "张");
    outputRow = pick(m.rows, OUTPUT_KEYS, "张");
  } else if (unitSet.every((u) => /小时/.test(u))) {
    skipped.push({ id: apiId, name: m.name, reason: "仅存储/缓存计量（千tokens/小时），非推理单价" });
    continue;
  }

  const map = billingUnit ? UNIT_MAP[billingUnit] : null;
  if (!map) {
    skipped.push({ id: apiId, name: m.name, reason: `计价单位无法映射：${unitSet.join(" / ") || "空"}` });
    continue;
  }

  let inputPrice = inputRow ? inputRow.price : 0;
  let outputPrice = outputRow ? outputRow.price : 0;
  // 图片：主站图片计费只取「输入侧」单价（unitsFor=张数），为保证按张收费准确，
  // 把图像生成输出单价同时写入输入/输出两侧
  if (map.unit === "image") {
    if (outputRow) {
      inputPrice = outputRow.price;
      outputPrice = outputRow.price;
    } else if (inputRow) {
      outputPrice = inputRow.price;
    }
  }
  if (!(inputPrice > 0) && !(outputPrice > 0)) {
    skipped.push({ id: apiId, name: m.name, reason: "表内无可用单价条目（仅基准项/缓存项）" });
    continue;
  }
  const currency = (outputRow || inputRow)?.currency || "CNY";

  if (dbModel.pricing_count > 0 && !OVERWRITE) {
    skipped.push({ id: apiId, name: m.name, reason: `库内已有 ${dbModel.pricing_count} 条定价（未加 --overwrite）` });
    continue;
  }

  ok.push({
    apiId,
    dbId: dbModel.id,
    name: m.name,
    endpointType: dbModel.endpointType,
    unit: map.unit,
    meterBase: map.meterBase,
    inputPrice,
    outputPrice,
    currency,
    source:
      map.unit === "image"
        ? `输出 ${outputRow?.key || "-"}=${outputRow?.price ?? "-"}（写入输入/输出两侧） ${currency}/${billingUnit}`
        : `${inputRow?.key || "-"}=${inputPrice} / ${outputRow?.key || "-"}=${outputPrice} ${currency}/${billingUnit}`,
  });
}

const dbOnly = dbModels.filter((m) => !arkModels.has(m.name));

// ── 报告 ──
console.log(`报价表：${CSV_PATH}`);
console.log(`厂商：${vendor.name}（id=${vendor.id}），库内模型 ${dbModels.length} 个，表内 API模型ID ${arkModels.size} 个`);
console.log(`\n=== 可导入 ${ok.length} 个 ===`);
for (const r of ok) {
  console.log(
    `${r.apiId}\t${r.unit}/${r.meterBase}\tin=${r.inputPrice}\tout=${r.outputPrice}\t${r.currency}\t×${MULTIPLIER_BPS / 10000}\t[${r.source}]`
  );
}
console.log(`\n=== 表内跳过 ${skipped.length} 个 ===`);
for (const r of skipped) console.log(`${r.id}\t${r.reason}`);
console.log(`\n=== 库内有、报价表无 ${dbOnly.length} 个（不改动）===`);
for (const m of dbOnly) console.log(`${m.name}\t${m.endpointType}\t${m.status}\tpricings=${m.pricing_count}`);

// ── 写入 ──
if (!APPLY) {
  console.log("\n[dry-run] 未写库。确认后加 --apply 执行。若需覆盖已有定价再加 --overwrite。");
} else if (ok.length === 0) {
  console.log("\n[apply] 没有需要写入的模型。");
} else {
  await client.query("BEGIN");
  try {
    for (const r of ok) {
      if (OVERWRITE) await client.query(`DELETE FROM model_pricing WHERE "modelId" = $1`, [r.dbId]);
      await client.query(
        `INSERT INTO model_pricing ("modelId","meterBase",unit,"inputPrice","outputPrice",currency,"fxRateE8","multiplierBps","effectiveAt")
         VALUES ($1,$2,$3,$4,$5,$6,100000000,$7,now())`,
        [r.dbId, r.meterBase, r.unit, r.inputPrice, r.outputPrice, r.currency, MULTIPLIER_BPS]
      );
    }
    await client.query("COMMIT");
    console.log(`\n[apply] 已写入 ${ok.length} 条 model_pricing。`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("\n[apply] 写入失败，已回滚：", e.message);
    process.exitCode = 1;
  }
}
await client.end();
