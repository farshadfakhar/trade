import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { coverage: { provider: 'v8', include: ['src/risk/**', 'src/config/**', 'src/exchange/**'], thresholds: { 'src/risk/**': { lines: 100, branches: 100, functions: 100, statements: 100 } } } },
});
