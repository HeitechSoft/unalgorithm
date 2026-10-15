import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { defineConfig, type UserManifest } from 'wxt';

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

/**
 * The server card and its `identity` permission (R47a): store builds leave them out until the Cloud beta notice, terms
 * and store disclosures are live. `UA_CLOUD=1` puts them in a production build; development and e2e builds always
 * have them. The UI reads the result as `import.meta.env.UA_CLOUD`.
 */
export function cloudEnabled(mode: string): boolean {
  return process.env.UA_CLOUD === '1' || mode === 'development' || mode === 'e2e';
}

/** Store and development builds ask for it at setup, as an optional permission; only e2e builds have it from the start. */
export const ANTHROPIC_HOST = 'https://api.anthropic.com/*';
/** As Anthropic: asked for at setup (OpenAI) or from the web search key's Save click (Brave), except in e2e builds. */
export const OPENAI_HOST = 'https://api.openai.com/*';
export const BRAVE_SEARCH_HOST = 'https://api.search.brave.com/*';

/** The manifest for a build mode. Pure, so tests can check every mode. */
export function manifestFor(mode: string): UserManifest {
  const e2e = mode === 'e2e';
  // `identity` opens a server's sign-in page (`launchWebAuthFlow`); the server card asks for it from the click that
  // starts a sign-in. Playwright can't answer that prompt, so e2e builds have it from the start.
  const identity = cloudEnabled(mode) && !e2e ? ['identity' as const] : [];
  return {
    name: '__MSG_extName__',
    short_name: 'UnAlgorithm',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    minimum_chrome_version: '130',
    homepage_url: 'https://unalgorithmfeed.com/',
    // `alarms` keeps settings sync on its 30-second rhythm (CL3-20); store builds without the server card leave it out.
    permissions: ['storage', 'sidePanel', 'scripting', ...(cloudEnabled(mode) ? ['alarms'] : []), ...(e2e ? ['identity'] : [])],
    host_permissions: [
      'https://www.linkedin.com/*',
      'https://www.facebook.com/*',
      // The e2e sign-in tab reports the URL it is sent back to only to a host permission for that address (CL1-16).
      // Anthropic and OpenAI are asked for at setup everywhere else, Brave from the web search key's Save click;
      // Playwright can't answer those prompts (P3-09, P3-47).
      ...(e2e
        ? ['http://127.0.0.1/*', `https://${devKey.id}.chromiumapp.org/*`, ANTHROPIC_HOST, OPENAI_HOST, BRAVE_SEARCH_HOST]
        : []),
    ],
    // AI endpoints are requested at setup, one origin at a time, from a click. Servers are reached through CORS
    // (ADR 0004).
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    optional_permissions: ['declarativeNetRequestWithHostAccess', ...identity],
    action: { default_title: 'UnAlgorithm' },
    ...(mode === 'production' ? {} : { key: devKey.key }),
  };
}

export default defineConfig({
  srcDir: 'src',
  imports: false,
  modules: ['@wxt-dev/module-react'],
  // UA_LICENSES=1 builds the production bundle with source maps into its own folder, so
  // scripts/third-party-notices.mjs can list exactly what ships.
  ...(licenses ? { outDirTemplate: '{{browser}}-mv{{manifestVersion}}-licenses' } : {}),
  vite: (env) => ({
    resolve: { dedupe: ['react', 'react-dom', 'zod'] },
    build: { sourcemap: licenses },
    define: { 'import.meta.env.UA_CLOUD': JSON.stringify(cloudEnabled(env.mode)) },
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
  manifest: ({ mode }) => manifestFor(mode),
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
