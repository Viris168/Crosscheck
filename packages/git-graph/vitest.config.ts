import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // The oracle suite builds real git repos in temp dirs.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // bench/scale.bench.ts measures retained memory after a GC
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
  },
});
