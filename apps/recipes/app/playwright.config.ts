import { defineConfig, devices } from "@playwright/test";
import { resolveDevVitePort } from "@kirkl/vite-preset";

// Per-worktree port so parallel Playwright runs each get their own vite
// server (else `reuseExistingServer: !CI` silently piggybacks the first
// one to bind on the default port). Recipes' standalone dev server uses
// base port 3000 (see vite.config.ts), so mirror that here.
const PORT = resolveDevVitePort(3000);
const URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // sequential — tests share a PB instance
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
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
      VITE_PB_URL: process.env.PB_TEST_URL || "http://127.0.0.1:8091",
    },
  },
});
