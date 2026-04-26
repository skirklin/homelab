/// <reference types="vitest" />
import { defineConfig } from 'vite'
import { kirklPlugins } from '@kirkl/vite-preset'

export default defineConfig({
  plugins: kirklPlugins({
    name: 'Life',
    shortName: 'Life',
    themeColor: '#13c2c2',
    importScripts: ['/push-sw.js'],
  }),
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
  },
})
