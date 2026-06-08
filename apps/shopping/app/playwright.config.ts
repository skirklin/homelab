import { defineConfig, devices } from "@playwright/test";
import { resolveDevVitePort, resolveTestPbUrl } from "@kirkl/vite-preset";

// Per-worktree port so parallel Playwright runs each get their own vite
// server (else `reuseExistingServer: !CI` silently piggybacks the first
// one to bind :5173).
const PORT = resolveDevVitePort();
const URL = `http://localhost:${PORT}`;
// Resolve the per-worktree test PB URL once at config load and publish it
// to the env so global-setup.ts (and the browser, via webServer.env) all
// hit the SAME database. Without this, `pnpm test:playwright` invoked
// directly from a worktree fell back to :8091 — main checkout's PB, i.e.
// some OTHER worktree's data on a parallel-sessions machine. Mirrors recipes.
const PB_URL = resolveTestPbUrl();
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
    command: "pnpm dev",
    url: URL,
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_PB_URL: PB_URL,
    },
  },
});
