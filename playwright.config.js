import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.browser.spec.js',
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  outputDir: 'work/playwright-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'node server.mjs',
    url: 'http://127.0.0.1:4173',
    env: { PORT: '4173' },
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
