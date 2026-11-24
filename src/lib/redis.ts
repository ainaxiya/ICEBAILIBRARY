import IORedis from "ioredis";

// ─── g15 / o13：Redis 共享状态客户端（限流 / 配额 / 并发槽 / 熔断） ───
// 与 video-queue 的 Redis 连接相互独立：
//   · 入队短连接（VIDEO_QUEUE_*，8s 命令超时）只用于 enqueue，用完即关；
//   · worker 长连接（无 commandTimeout，供 BullMQ 阻塞读取）由 BullMQ 持有；
//   · 本客户端服务请求热路径，必须「秒级失败、立刻回退进程内」，绝不挂住请求。
// 未配置 REDIS_URL 时返回 null，所有调用方按既有进程内实现降级（本地/测试零配置可跑）。

let client: IORedis | null = null;
let initialized = false;

export function redisEnabled(): boolean {
  return !!process.env.REDIS_URL;
}

const CONNECT_TIMEOUT_MS = Number(process.env.SHARED_REDIS_CONNECT_TIMEOUT_MS) || 1_000;
const COMMAND_TIMEOUT_MS = Number(process.env.SHARED_REDIS_TIMEOUT_MS) || 800;

export function getSharedRedis(): IORedis | null {
  if (!redisEnabled()) return null;
  if (initialized) return client;
  initialized = true;
  try {
    const c = new IORedis(process.env.REDIS_URL!, {
      connectTimeout: CONNECT_TIMEOUT_MS,
      commandTimeout: COMMAND_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      // 冷启动首个命令要等握手完成；关掉离线排队会让「进程刚启动的第一个请求」
      // 直接误降级为进程内限流（跨实例计数失效）。
      enableOfflineQueue: true,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1_000)),
    });
    // ioredis 的 error 事件必须有监听，否则连接被拒会抛未处理异常
    c.on("error", (e: Error) => {
      console.error("[redis] 共享状态连接异常:", e.message.slice(0, 160));
    });
    client = c;
  } catch (e) {
    console.error("[redis] 共享状态客户端创建失败，回退进程内:", (e as Error).message.slice(0, 160));
    client = null;
  }
  return client;
}
