import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/tests/**/*.test.ts', 'examples/**/tests/**/*.test.ts'],
    exclude: ['dist/**'],
  },
});
