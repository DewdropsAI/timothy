import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**', 'control-panel/**', 'src/__tests__/e2e/**', '.claude/worktrees/**'],
  },
});
