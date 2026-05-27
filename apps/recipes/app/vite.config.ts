/// <reference types="vitest" />
import { defineConfig } from 'vite'
import { kirklPlugins, resolveDevVitePort } from '@kirkl/vite-preset'

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
