import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(here, 'src'),
      // `server-only` throws outside React Server Components; tests run server code directly.
      'server-only': path.resolve(here, 'test/server-only-stub.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Tests never need real secrets; env.ts is exercised explicitly in env.test.ts.
    env: { SKIP_ENV_VALIDATION: '1' },
  },
});
