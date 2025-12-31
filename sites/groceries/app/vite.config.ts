import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.spec.ts',  // Exclude Playwright tests
      '**/e2e/*.spec.ts',
    ],
  },
})
