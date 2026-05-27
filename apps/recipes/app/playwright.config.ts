import { defineConfig, devices } from "@playwright/test";
import { resolveDevVitePort } from "@kirkl/vite-preset";

// Recipes' vite config uses base port 3000 historically. Per-worktree
// offset mirrors the shopping/home configs so parallel runs don't share
// a dev server.
const PORT = resolveDevVitePort(3000);
const URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
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
});
