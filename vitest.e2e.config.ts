import { defineConfig } from "vitest/config";
import path from "path";

// E2E 契约测试：global-setup 起独立 next 生产服务（:3100，指向 prompthub_test 库）
// + mock OpenAI 上游（:19800），测试通过 HTTP 打真实路由，断言完整计费链路
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/e2e/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
