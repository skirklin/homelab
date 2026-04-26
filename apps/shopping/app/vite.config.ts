/// <reference types="vitest" />
import { defineConfig } from 'vite'
import { kirklPlugins } from '@kirkl/vite-preset'

export default defineConfig({
  plugins: kirklPlugins({ name: 'Shopping', shortName: 'Shopping', themeColor: '#52c41a' }),
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
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.spec.ts',
      '**/e2e/*.spec.ts',
    ],
  },
})
