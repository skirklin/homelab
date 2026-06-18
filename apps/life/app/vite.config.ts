/// <reference types="vitest" />
import { defineConfig } from 'vite'
import { kirklPlugins, resolveDevApiTarget, resolveDevVitePort } from '@kirkl/vite-preset'

// PWA web-manifest `shortcuts[]` were derived from hardcoded trackable presets
// and deep-linked into the now-removed `/quick` route. With per-user trackables
// (manifest-driven, no build-time list) a static shortcut list can't be
// per-user-correct, so it was dropped (P3). Quick entry now lives in-app as the
// pins + frecency chips on each card and the global quick-log row.

export default defineConfig({
  plugins: kirklPlugins({
    name: 'Life',
    shortName: 'Life',
    themeColor: '#13c2c2',
    importScripts: ['/push-sw.js'],
  }),
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
    globals: true,
    environment: 'happy-dom',
    setupFiles: './src/setupTests.ts',
    // One retry absorbs a transient host-contention race in the PB-hitting
    // e2e specs under src/e2e/ (parallel deploy gates share a swap-less box).
    // A genuinely broken test still fails twice. Flake-absorber for resource
    // contention, NOT a license to ship flaky code.
    retry: 1,
  },
})
