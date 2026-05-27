import { defineConfig } from 'vite'
import { kirklPlugins, resolveDevApiTarget } from '@kirkl/vite-preset'

export default defineConfig({
  plugins: kirklPlugins({
    name: 'kirkl.in',
    shortName: 'Home',
    themeColor: '#1677ff',
    importScripts: ['/push-sw.js'],
  }),
  build: {
    outDir: 'dist',
  },
  resolve: {
    dedupe: ['react', 'react-dom', 'react-router-dom'],
  },
  server: {
    proxy: {
      '/fn': {
        target: resolveDevApiTarget(),
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/fn/, ''),
      },
    },
  },
})
