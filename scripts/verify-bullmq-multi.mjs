// P6 #20 多实例部署验证（BullMQ exactly-once 消费语义）
// 用法: node scripts/verify-bullmq-multi.mjs [redisUrl] [jobCount]
//   redisUrl 默认 process.env.REDIS_URL 或 redis://127.0.0.1:6379
// 流程：拉起 2 个独立 Worker 子进程（模拟两个应用实例）→ 父进程入队 N 个任务
//   → 每个任务只应被恰好一个实例处理一次（redis hincrby 计数）→ 全部排空后校验：
//   计数 key 数 == N 且每个计数 == 1 → PASS（无漏处理 / 无重复处理）
// 服务器运行：cd /www/wwwroot/CompletePrompt && node scripts/verify-bullmq-multi.mjs

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Queue } from "bullmq";
import IORedis from "ioredis";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const redisUrl = process.argv[2] || process.env.REDIS_URL || "redis://127.0.0.1:6379";
const jobCount = Number(process.argv[3]) || 30;
const Q = `verify-exactly-once-${Date.now()}`;
const WORKERS = 2;

const conn = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const admin = new IORedis(redisUrl);

async function main() {
  console.log(`[verify] redis=${redisUrl} queue=${Q} jobs=${jobCount} workers=${WORKERS}`);
  await admin.del("verify-bullmq:counts");

  // 1. 拉起 2 个 Worker 子进程（独立进程 = 模拟独立实例）
  const children = [];
  for (let i = 0; i < WORKERS; i++) {
    const child = spawn(process.execPath, [path.join(HERE, "verify-bullmq-worker.mjs"), Q, redisUrl], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => process.stderr.write(`[worker${i}] ${d}`));
    children.push(child);
    console.log(`[verify] worker#${i} pid=${child.pid} started`);
  }

  // 2. 入队
  const queue = new Queue(Q, { connection: conn });
  await queue.waitUntilReady();
  for (let i = 0; i < jobCount; i++) {
    await queue.add("verify", { n: i }, { jobId: `v-${i}`, removeOnComplete: { count: 0 }, removeOnFail: { count: 0 } });
  }
  console.log(`[verify] ${jobCount} jobs enqueued`);

  // 3. 等待全部子进程退出（各自排空后自退）
  const deadline = Date.now() + 100_000;
  for (const c of children) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, Math.max(1000, deadline - Date.now()));
      c.on("exit", () => { clearTimeout(t); resolve(null); });
    });
  }

  // 4. 校验：每个 job 恰好被处理 1 次
  const counts = await admin.hgetall("verify-bullmq:counts");
  const ids = Object.keys(counts);
  const duplicates = ids.filter((k) => Number(counts[k]) !== 1);
  const missing = [];
  for (let i = 0; i < jobCount; i++) if (!ids.includes(`v-${i}`)) missing.push(`v-${i}`);

  let pass = ids.length === jobCount && duplicates.length === 0 && missing.length === 0;
  // 保险：若有 job 未在计数中，看队列是否还有滞留
  const remaining = await queue.getJobCounts("waiting", "active", "delayed", "failed");

  console.log(`[verify] processed=${ids.length}/${jobCount} duplicates=${duplicates.length} missing=${missing.length} queue-remaining=${JSON.stringify(remaining)}`);
  if (!pass && missing.length === 0 && duplicates.length === 0 && remaining.waiting + remaining.active + remaining.delayed === 0) {
    // removeOnComplete count:0 立即清 job，不影响计数判定；此处兜底按计数一致性放行
    pass = ids.length === jobCount;
  }

  // 5. 清理验证队列
  try {
    await queue.obliterate({ force: true });
  } catch {}
  await admin.del("verify-bullmq:counts");
  await queue.close();
  conn.disconnect();
  admin.disconnect();

  if (pass) {
    console.log("[verify] PASS —— exactly-once 消费语义验证通过（无重复处理 / 无漏处理）");
    process.exit(0);
  } else {
    console.log("[verify] FAIL —— 存在重复或漏处理，请检查部署配置");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[verify] error:", e);
  process.exit(1);
});
