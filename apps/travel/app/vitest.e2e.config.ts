import { defineConfig } from "vitest/config";

// Per-worktree PB port: honor PB_TEST_URL from the parent shell (set by
// infra/test-env.sh / deploy.sh). Falls back to the legacy default for
// the main checkout. See infra/test-env.sh for the derivation algorithm.
const PB_TEST_URL = process.env.PB_TEST_URL || "http://127.0.0.1:8091";

export default defineConfig({
  test: {
    include: ["src/e2e/**/*.e2e.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    env: { PB_TEST_URL },
  },
});
