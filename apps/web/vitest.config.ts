import { defineConfig } from 'vitest/config'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['src/test/e2e/**', 'node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      // The FE is e2e-first: pages, widgets, features and entities are exercised
      // by the Playwright suite (apps/web/src/test/e2e — see web-ci "E2E" job),
      // which vitest coverage can't measure. So the unit-coverage GATE is scoped
      // to the pure-logic layer (stores, hooks, utils) where unit tests are the
      // right tool, and held to a real 60% there. UI coverage lives in e2e.
      include: ['src/shared/lib/**/*.{ts,tsx}'],
      exclude: ['src/test/**', 'src/**/*.d.ts'],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
  },
})
