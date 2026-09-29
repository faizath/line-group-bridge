import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: {
        'src/translate/**': { lines: 80 },
        'src/cost/**': { lines: 80 },
        'src/delivery/**': { lines: 80 },
      },
    },
  },
});
