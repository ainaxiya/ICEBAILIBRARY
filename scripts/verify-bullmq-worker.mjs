// P6 #20 多实例消费验证：验证 Worker 子进程（每个代表一个独立实例）
// 用法: node scripts/verify-bullmq-worker.mjs <queueName> <redisUrl>
// 行为：消费队列全部任务；每个任务处理完 redis.hincrby 计数一次；
//      队列排空（连续 3 次 waiting+active+delayed == 0）后自动退出。

import { Worker } from "bullmq";
import IORedis from "ioredis";

const [, , queueName, redisUrl] = process.argv;
if (!queueName || !redisUrl) {
  console.error("usage: node verify-bullmq-worker.mjs <queueName> <redisUrl>");
  process.exit(1);
}

const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const counts = new IORedis(redisUrl);

const worker = new Worker(
  queueName,
  async (job) => {
    await counts.hincrby("verify-bullmq:counts", String(job.id), 1);
  },
  { connection, concurrency: 8 }
);

let idleRounds = 0;
const timer = setInterval(async () => {
  try {
    const c = await worker.getJobCounts("waiting", "active", "delayed", "completed", "failed");
    if (c.waiting + c.active + c.delayed === 0) {
      idleRounds++;
      if (idleRounds >= 3) {
        clearInterval(timer);
        await worker.close();
        connection.disconnect();
        counts.disconnect();
        process.exit(0);
      }
    } else {
      idleRounds = 0;
    }
  } catch {
    // 连接抖动忽略，下一轮再看
  }
}, 500);

// 兜底：90s 强制退出
setTimeout(() => process.exit(0), 90_000);
