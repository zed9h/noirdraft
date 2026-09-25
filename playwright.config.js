import { defineConfig } from '@playwright/test';

// Inherited by every launched Electron app: dirty windows close without the unsaved-changes prompt.
process.env.NOIRDRAFT_E2E_FORCE_CLOSE = '1';

export default defineConfig({
  testDir: './test/e2e',
  // Every test finishes in a few seconds when healthy; a stuck one should fail fast.
  timeout: 10_000,
  expect: { timeout: 3_000 },
  // Each test launches its own Electron app and fake server, so they parallelize cleanly.
  workers: 6,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'retain-on-failure' },
});
