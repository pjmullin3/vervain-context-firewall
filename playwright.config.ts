import { defineConfig, devices } from '@playwright/test';

const e2ePort = Number(process.env.E2E_PORT ?? '4178');
const baseURL = process.env.TARGET_BASE_URL ?? `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 180000,
  expect: {
    timeout: 15000,
  },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: process.env.TARGET_BASE_URL
    ? undefined
    : {
        command: `PORT=${e2ePort} DEMO_MODE=mock SESSION_SECRET=e2e_synthetic_session_secret_32bytes_min node dist/server/server/index.js`,
        url: `${baseURL}/readyz`,
        reuseExistingServer: false,
        timeout: 15000,
      },
});
