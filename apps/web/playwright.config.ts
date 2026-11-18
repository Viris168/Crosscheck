import { defineConfig, devices } from '@playwright/test';

// e2e smoke against `next dev` + the seeded dev database (pnpm db:seed).
// Run: pnpm --filter @app/web test:e2e   (loads ../../.env for DATABASE_URL / BETTER_AUTH_SECRET)
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
