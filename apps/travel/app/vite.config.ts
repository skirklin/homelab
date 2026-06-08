/// <reference types="vitest" />
import { defineConfig } from 'vite'
import { kirklPlugins, resolveDevVitePort } from '@kirkl/vite-preset'

export default defineConfig({
  plugins: kirklPlugins({ name: 'Travel', shortName: 'Travel', themeColor: '#1677ff' }),
  server: {
    port: resolveDevVitePort(),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'e2e/**',
    ],
    // One retry absorbs a transient host-contention race in the PB-hitting
    // e2e specs under src/e2e/ (parallel deploy gates share a swap-less box).
    // A genuinely broken test still fails twice. Flake-absorber for resource
    // contention, NOT a license to ship flaky code.
    retry: 1,
  },
})
