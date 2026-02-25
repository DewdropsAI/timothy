import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/e2e/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**', 'control-panel/**'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
