import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.{test,spec}.{ts,tsx}", "packages/*/src/**/*.{test,spec}.ts"],
    passWithNoTests: true,
    environment: "node",
    // CI runner（2 核）默认会按文件数起满 worker：68 个文件同时跑，抢 CPU 的结果是
    // 起真库/真 HTTP 的测试撞上 5s 默认超时（2026-11-10 实测 media / migration / routerApi
    // 三条同时超时，而那次提交只改了 markdown）。限成 2 个并发，把预算让给单条测试。
    ...(process.env.CI === "true" ? { maxWorkers: 2, minWorkers: 1 } : {}),
  },
});
