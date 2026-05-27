/// <reference types="vitest" />
import { defineConfig } from 'vite'
import { kirklPlugins, resolveDevApiTarget, resolveDevVitePort } from '@kirkl/vite-preset'

export default defineConfig({
  plugins: kirklPlugins({ name: 'Shopping', shortName: 'Shopping', themeColor: '#52c41a' }),
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
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.spec.ts',
      '**/e2e/*.spec.ts',
    ],
  },
})
