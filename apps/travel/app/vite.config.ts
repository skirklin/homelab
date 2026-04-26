/// <reference types="vitest" />
import { defineConfig } from 'vite'
import { kirklPlugins } from '@kirkl/vite-preset'

export default defineConfig({
  plugins: kirklPlugins({ name: 'Travel', shortName: 'Travel', themeColor: '#1677ff' }),
  test: {
    globals: true,
    environment: 'jsdom',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'e2e/**',
    ],
  },
})
