import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'e2e/**',
    ],
    // One retry absorbs a transient host-contention race in the PB-hitting
    // e2e specs under src/e2e/ (parallel deploy gates share a swap-less box).
    // A genuinely broken test still fails twice. Flake-absorber for resource
    // contention, NOT a license to ship flaky code.
    retry: 1,
  },
})
