/// <reference types="vitest" />
import { defineConfig } from 'vite'
import { kirklPlugins, resolveDevApiTarget, resolveDevVitePort } from '@kirkl/vite-preset'

export default defineConfig({
  plugins: kirklPlugins({ name: 'Shopping', shortName: 'Shopping', themeColor: '#52c41a' }),
  server: {
    port: resolveDevVitePort(),
    proxy: {
      '/fn': {
        target: resolveDevApiTarget(),
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/fn/, ''),
      },
    },
  },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.spec.ts',
      '**/e2e/*.spec.ts',
    ],
    // One retry absorbs a transient host-contention race in the PB-hitting
    // e2e specs under src/e2e/ (parallel deploy gates share a swap-less box).
    // A genuinely broken test still fails twice. Flake-absorber for resource
    // contention, NOT a license to ship flaky code.
    retry: 1,
  },
})
