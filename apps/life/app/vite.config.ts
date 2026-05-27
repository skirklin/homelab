/// <reference types="vitest" />
import { defineConfig } from 'vite'
import { kirklPlugins, resolveDevApiTarget, resolveDevVitePort } from '@kirkl/vite-preset'
import { TRACKABLES } from './src/trackables'

/**
 * Derive PWA web-manifest `shortcuts[]` from the trackable presets. Each
 * preset on a trackable becomes one shortcut that deep-links into
 * `/quick/<trackableId>?v=<canonicalValue>`, where the React route logs the
 * event and bounces back to /. Generating here means the shortcuts can't
 * drift from the in-app preset chips.
 */
const pwaShortcuts = TRACKABLES.flatMap((t) =>
  (t.presets ?? []).map((p) => ({
    name: `Log ${p.label} ${t.label.toLowerCase()}`,
    short_name: `${p.label} ${t.label.toLowerCase()}`,
    url: `/quick/${t.id}?v=${p.value}`,
  })),
)

export default defineConfig({
  plugins: kirklPlugins({
    name: 'Life',
    shortName: 'Life',
    themeColor: '#13c2c2',
    importScripts: ['/push-sw.js'],
    shortcuts: pwaShortcuts,
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
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
  },
})
