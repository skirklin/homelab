/// <reference types="vitest" />
import { defineConfig } from 'vite'
import { kirklPlugins, resolveDevApiTarget, resolveDevVitePort } from '@kirkl/vite-preset'

export default defineConfig({
  plugins: kirklPlugins({
    name: 'RecipeBox',
    shortName: 'RecipeBox',
    icons: [
      { src: '/logo192.png', sizes: '192x192', type: 'image/png' },
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  }),
  server: {
    port: resolveDevVitePort(3000),
    // Proxy /fn → API service so createShareInvite, AI enrich, owner-info
    // round-trips work in `pnpm dev` (and Playwright). resolveDevApiTarget
    // discovers the per-worktree API port from infra/test-env.sh.
    proxy: {
      '/fn': {
        target: resolveDevApiTarget(),
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/fn/, ''),
      },
    },
  },
  build: {
    outDir: 'build',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'e2e/**',
    ],
  },
})
