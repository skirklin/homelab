/// <reference types="vitest" />
import { defineConfig } from 'vite'
import { kirklPlugins } from '@kirkl/vite-preset'

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
        target: process.env.VITE_API_URL || 'http://127.0.0.1:3001',
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
