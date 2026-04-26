/// <reference types="vitest" />
import { defineConfig } from 'vite'
import { kirklPlugins } from '@kirkl/vite-preset'

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
    port: 3000,
    open: true,
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
