import { defineConfig } from "vitest/config";
import path from "path";
import { TEST_DB_URL } from "./tests/db-target";

// 单元测试：直连本地 PG 上的独立测试库（默认 <DATABASE_URL 库名>_test，如 icebaidata_test）
// 不自建实例、不 initdb、不占用 5432；目标库由 tests/db-target.ts 统一解析
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Next 用环境条件标记 server-only，node 环境单测里替换为空模块
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/unit-setup.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: TEST_DB_URL,
      STORAGE_KEY_SECRET: "test-storage-secret",
      JWT_SECRET: "test-jwt-secret",
      JWT_ADMIN_SECRET: "test-admin-jwt-secret",
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // 串行跑：单元测试共享测试库，避免写冲突
    fileParallelism: false,
  },
});
