import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'retain-on-failure' },
});
