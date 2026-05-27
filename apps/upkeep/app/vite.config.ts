/// <reference types="vitest" />
import { defineConfig } from 'vite'
import { kirklPlugins, resolveDevApiTarget } from '@kirkl/vite-preset'

export default defineConfig({
  plugins: kirklPlugins({
    name: 'Upkeep',
    shortName: 'Upkeep',
    themeColor: '#722ed1',
    importScripts: ['/push-sw.js'],
  }),
  server: {
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
