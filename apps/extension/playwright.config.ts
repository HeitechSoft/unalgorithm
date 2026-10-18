import { defineConfig } from '@playwright/test';

/**
 * Three projects, each on its own e2e build (ADR 0008): `chromium` and `edge` run the same specs through Playwright,
 * `firefox` runs `e2e/firefox/` through Puppeteer over WebDriver BiDi, with Playwright Test as the runner. Run one at a
 * time (`pnpm e2e`, `pnpm e2e:edge`, `pnpm e2e:firefox`); each needs its own build first.
 */
// The worker option `e2e/fixtures.ts` declares (its `ExtensionBrowser`); e2e/ isn't typechecked, so not imported here.
export default defineConfig<object, { extensionBrowser: 'chromium' | 'edge' }>({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', testIgnore: '**/firefox/**', use: { extensionBrowser: 'chromium' } },
    // The store screenshots are Chrome's (docs/store), so only the chromium project takes them.
    { name: 'edge', testIgnore: ['**/firefox/**', '**/store.spec.ts'], use: { extensionBrowser: 'edge' } },
    // Starting Firefox and installing the add-on takes longer than a Chromium launch.
    { name: 'firefox', testDir: './e2e/firefox', timeout: 90_000 },
  ],
});
