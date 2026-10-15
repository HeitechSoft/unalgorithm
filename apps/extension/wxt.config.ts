import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { defineConfig } from 'wxt';

/**
 * Public half of a development key so unpacked dev and E2E builds always get the same extension ID
 * (stable OAuth redirects and local-model allowlists). Store builds never include it: the Chrome Web Store
 * assigns the published ID.
 */
const devKey = JSON.parse(readFileSync(resolve(import.meta.dirname, 'dev-key.json'), 'utf8')) as { key: string; id: string };

const startUrl = process.env.UA_START === 'facebook' ? 'https://www.facebook.com/' : 'https://www.linkedin.com/feed/';

/**
 * Branded Chrome 137+ ignores --load-extension, so `pnpm dev` runs Playwright's Chromium (install it once with
 * `pnpm exec playwright install chromium`). Set UA_CHROME to use another Chromium or Chrome for Testing binary.
 */
function devBrowser(): string | undefined {
  if (process.env.UA_CHROME) return process.env.UA_CHROME;
  try {
    const path = chromium.executablePath();
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

const devChrome = devBrowser();
const licenses = process.env.UA_LICENSES === '1';

export default defineConfig({
  srcDir: 'src',
  imports: false,
  modules: ['@wxt-dev/module-react'],
  // UA_LICENSES=1 builds the production bundle with source maps into its own folder, so
  // scripts/third-party-notices.mjs can list exactly what ships.
  ...(licenses ? { outDirTemplate: '{{browser}}-mv{{manifestVersion}}-licenses' } : {}),
  vite: () => ({
    resolve: { dedupe: ['react', 'react-dom', 'zod'] },
    build: { sourcemap: licenses },
  }),
  hooks: {
    // Every zip carries the licence and the notices for the bundled open-source code.
    'build:publicAssets': (_wxt, files) => {
      files.push(
        { absoluteSrc: resolve(import.meta.dirname, '../../LICENSE'), relativeDest: 'LICENSE.txt' },
        { absoluteSrc: resolve(import.meta.dirname, '../../THIRD_PARTY_NOTICES.md'), relativeDest: 'THIRD_PARTY_NOTICES.md' },
      );
    },
  },
  manifest: ({ mode }) => ({
    name: '__MSG_extName__',
    short_name: 'UnAlgorithm',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    minimum_chrome_version: '130',
    homepage_url: 'https://unalgorithmfeed.com/',
    permissions: ['storage', 'sidePanel', 'scripting'],
    host_permissions: [
      'https://www.linkedin.com/*',
      'https://www.facebook.com/*',
      ...(mode === 'e2e' ? ['http://127.0.0.1/*'] : []),
    ],
    // AI endpoints are requested at setup, one origin at a time, from a click.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    optional_permissions: ['declarativeNetRequestWithHostAccess'],
    action: { default_title: 'UnAlgorithm' },
    ...(mode === 'production' ? {} : { key: devKey.key }),
  }),
  webExt: {
    ...(devChrome ? { binaries: { chrome: devChrome } } : {}),
    chromiumProfile: resolve(import.meta.dirname, '.wxt/chrome-data'),
    keepProfileChanges: true,
    startUrls: [startUrl],
  },
  zip: {
    artifactTemplate: 'unalgorithm-{{version}}-{{browser}}.zip',
  },
});
