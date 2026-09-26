import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against a running AgentForge (all-in-one, seeded demo data):
 *   pnpm --filter @agentforge/server db:migrate && pnpm --filter @agentforge/server db:seed
 *   SERVE_WEB=true NODE_ENV=production pnpm --filter @agentforge/server start
 *   E2E_BASE_URL=http://localhost:4000 pnpm e2e
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4000',
    trace: 'retain-on-failure',
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
