import { defineConfig, devices } from "@playwright/test";
import { resolveDevVitePort, resolveTestPbUrl } from "@kirkl/vite-preset";

// Each worktree gets a deterministic port offset so two parallel
// Playwright runs don't share a vite server via `reuseExistingServer`.
// Home historically launched on `:5174` (a one-off bump off vite's
// default `:5173`); keep that base so main checkout's port is stable.
const PORT = resolveDevVitePort(5174);
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
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
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
    env: {
      VITE_PB_URL: PB_URL,
    },
  },
});
