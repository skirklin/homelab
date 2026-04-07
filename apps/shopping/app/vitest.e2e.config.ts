import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/e2e/**/*.e2e.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      PB_TEST_URL: "http://127.0.0.1:8091",
    },
  },
});
