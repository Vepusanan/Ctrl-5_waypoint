import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

const externalBaseUrl = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './tests',
  forbidOnly: Boolean(process.env.CI),
  // Real-stack specs share the four seeded accounts and one database, so they run one at a time.
  ...(process.env.E2E_REAL_STACK === 'true' ? { workers: 1 } : {}),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: externalBaseUrl ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command: 'pnpm --filter @waypoint/web dev',
          url: 'http://localhost:5173',
          reuseExistingServer: !process.env.CI,
        },
      }),
});
