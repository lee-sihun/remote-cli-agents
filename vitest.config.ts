import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@rca/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    exclude: ['**/dist/**', '**/node_modules/**'],
    restoreMocks: true,
    clearMocks: true,
  },
});
