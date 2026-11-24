// PM2 进程配置（宝塔 Node/PM2 项目使用）
// 用法：pm2 start ecosystem.config.cjs && pm2 save
// 端口与内存上限从环境变量读取，缺省与历史配置一致（3000 / 1G）
const PORT = process.env.PORT || "3000";
const MAX_MEMORY = process.env.PM2_MAX_MEMORY || "1G";
const WORKER_MAX_MEMORY = process.env.PM2_WORKER_MAX_MEMORY || "512M";

module.exports = {
  apps: [
    {
      name: "CompletePrompt",
      // Next.js 生产模式启动（需先执行 npm run build）
      script: "node_modules/next/dist/bin/next",
      args: `start -p ${PORT}`,
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT,
      },
      max_memory_restart: MAX_MEMORY,
      autorestart: true,
      max_restarts: 10,
    },
    {
      // P6 #22 独立消费进程：视频 / 图片 / 产物下载三条队列
      // 产物由 npm run build 生成（worker/main.cjs），服务器不参与构建
      name: "CompletePrompt-Worker",
      script: "worker/main.cjs",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
      max_memory_restart: WORKER_MAX_MEMORY,
      autorestart: true,
      max_restarts: 30,
      // 收到 SIGTERM 后给在跑任务一点收尾时间；管理页的优雅重启会自行等待任务完成
      kill_timeout: 30_000,
    },
  ],
};
