// Next.js 服务启动钩子（S0-1 安全加固）
// 生产环境关键安全变量缺失时直接 fail-fast，禁止以不安全默认值启动。
// 开发环境不校验，保证本地零配置可跑。

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // S0-3：计费对账重试循环（settle/refund 失败的幂等兜底，60s 一轮；开发环境也运行便于本地验证）
  try {
    const { startBillingReconcileLoop } = await import("./lib/gateway/billing-reconcile");
    startBillingReconcileLoop();
  } catch (e) {
    console.error("[instrumentation] billing-reconcile loop 启动失败", e);
  }

  // M5：实验场媒体任务的重启恢复不放在这里——instrumentation 会被 edge 运行时二次编译，
  // media-task-runner 依赖链带 node 内置模块（crypto/dns/net）会拖垮 edge 编译（同 P6 #20 教训）。
  // 改挂在 /api/playground/tasks 路由模块加载时调度。

  // P6 #20：BullMQ video worker 改为在 /v1/videos 路由模块加载时启动
  // （video-queue 依赖 bullmq→pg，instrumentation 会被 edge 运行时二次编译吞不下 node 内置模块）

  // S0-1：生产环境关键变量缺失 fail-fast（开发环境跳过，保证零配置可跑）
  if (process.env.NODE_ENV !== "production") return;

  const missing: string[] = [];
  if (!process.env.JWT_SECRET) missing.push("JWT_SECRET");
  if (missing.length) {
    throw new Error(
      `[security] Missing required env in production: ${missing.join(", ")}. ` +
        `Refusing to start with insecure defaults.`
    );
  }
}
