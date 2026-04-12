import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/e2e/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Tests run against a real PocketBase + API server
    // Start PB: docker compose -f docker-compose.test.yml up -d
    // Start API: PB_URL=http://127.0.0.1:8091 PORT=3456 npx tsx src/index.ts
  },
});
