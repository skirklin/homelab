import { defineConfig, devices } from "@playwright/test";
import { resolveDevVitePort, resolveTestPbUrl } from "@kirkl/vite-preset";

// Per-worktree port so parallel Playwright runs each get their own vite
// server (else `reuseExistingServer: !CI` silently piggybacks the first
// one to bind on the default port). Recipes' standalone dev server uses
// base port 3000 (see vite.config.ts), so mirror that here.
const PORT = resolveDevVitePort(3000);
const URL = `http://localhost:${PORT}`;
// Discover the per-worktree test PB URL so the browser, the fixtures'
// admin client, and the API container's docker-internal PB all talk to
// the SAME database. Without this, `pnpm test:playwright` invoked
// directly (no deploy.sh wrapper) fell back to :8091 — which is some
// OTHER worktree's PB on a parallel-sessions machine. See the helper
// docstring in @kirkl/vite-preset for the failure mode.
const PB_URL = resolveTestPbUrl();
// Make the resolved URL visible to fixtures.ts and global-setup.ts,
// which read `process.env.PB_TEST_URL` directly. Setting it here at
// config-load time covers the `pnpm test:playwright` direct-invocation
// path; `deploy.sh` already exports it earlier in the pre-deploy gate.
process.env.PB_TEST_URL = PB_URL;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // sequential — tests share a PB instance
  forbidOnly: !!process.env.CI,
  // Local retry=1 absorbs a transient host-contention race during the deploy
  // gate (parallel Claude sessions share a swap-less box). A genuinely broken
  // spec still fails twice. Flake-absorber for resource contention, NOT a
  // license to ship flaky code. CI keeps 2.
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: "html",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm dev --port ${PORT}`,
    url: URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      VITE_PB_URL: PB_URL,
    },
  },
});
