import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { FIREFOX_ADDON_ID, FIREFOX_DEV_ADDON_ID } from '@unalgorithm/protocol';
import { defineConfig, type UserManifest } from 'wxt';

/**
 * Public half of a development key so unpacked dev and E2E builds always get the same extension ID in Chrome and Edge
 * (stable OAuth redirects and local-model allowlists). Store builds never include it: each store assigns the
 * published ID. Firefox takes its ID from `browser_specific_settings` instead (ADR 0008).
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

/** Where Microsoft Edge installs itself, per platform. */
const EDGE_PATHS = [
  '/opt/microsoft/msedge/msedge',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

/**
 * `pnpm dev:edge` runs the installed Edge (set UA_EDGE to another binary). web-ext loads the build over the DevTools
 * pipe, which branded Edge allows, unlike `--load-extension`.
 */
const devEdge = process.env.UA_EDGE || EDGE_PATHS.find((path) => existsSync(path));

/**
 * Persistent dev profiles (sign in once). The launcher writes its log here before Chrome starts, so it must exist.
 * Chrome and Edge each get their own (`dev:edge` sets UA_DEV_PROFILE): one browser's profile is no use to the other.
 */
const devProfile = resolve(import.meta.dirname, '.wxt', process.env.UA_DEV_PROFILE || 'chrome-data');
mkdirSync(devProfile, { recursive: true });
/**
 * `pnpm dev:firefox` runs the Firefox web-ext finds (set UA_FIREFOX to another binary or channel, e.g. `deved`). It
 * loads the build as a temporary add-on, which release Firefox allows unsigned. web-ext needs the folder to exist.
 */
const devFirefoxProfile = resolve(import.meta.dirname, '.wxt/firefox-data');
mkdirSync(devFirefoxProfile, { recursive: true });
const licenses = process.env.UA_LICENSES === '1';

/**
 * GitHub release sideload builds (ADR 0008, `UA_SIDELOAD=1`): the store build with the development identity, so a copy
 * loaded from a release has an id that servers accept. Chrome and Edge get the dev key; Firefox gets the development
 * add-on id, and the release has AMO sign that build as an unlisted add-on. Same bundle, same `UA_CLOUD` switch.
 */
const sideload = process.env.UA_SIDELOAD === '1';

/** The sideload identity on a production manifest; anything else is returned unchanged. */
export function sideloadManifest<M extends object>(manifest: M, browser: string, mode: string): M {
  if (mode !== 'production') return manifest;
  if (browser !== 'firefox') return { ...manifest, key: devKey.key };
  const settings = (manifest as { browser_specific_settings?: { gecko?: object } }).browser_specific_settings;
  return { ...manifest, browser_specific_settings: { ...settings, gecko: { ...settings?.gecko, id: FIREFOX_DEV_ADDON_ID } } };
}

/**
 * The server card and its `identity` permission (R47a): store builds leave them out until the Cloud beta notice, terms
 * and store disclosures are live. `UA_CLOUD=1` puts them in a production build; development and e2e builds always
 * have them. The UI reads the result as `import.meta.env.UA_CLOUD`.
 */
export function cloudEnabled(mode: string): boolean {
  return process.env.UA_CLOUD === '1' || mode === 'development' || mode === 'e2e';
}

/**
 * Where e2e builds send problem reports instead of unAlgorithm Cloud (ADR 0009 §1): the test server, which the report
 * specs start on this fixed port (`e2e/server-harness.ts`, `E2E_REPORTS_PORT`), since the address is built in. Every
 * other build sends to the protocol's `REPORTS_URL` and nowhere else.
 */
export const E2E_REPORTS_URL = 'http://127.0.0.1:47911/v1/reports';

/** The problem report address a build mode bakes in, or null for `REPORTS_URL` (every build but e2e). */
export function reportsUrlFor(mode: string): string | null {
  return mode === 'e2e' ? E2E_REPORTS_URL : null;
}

/** Store and development builds ask for it at setup, as an optional permission; only e2e builds have it from the start. */
export const ANTHROPIC_HOST = 'https://api.anthropic.com/*';
/** As Anthropic: asked for at setup (OpenAI) or from the web search key's Save click (Brave), except in e2e builds. */
export const OPENAI_HOST = 'https://api.openai.com/*';
export const BRAVE_SEARCH_HOST = 'https://api.search.brave.com/*';

/**
 * The oldest Firefox with everything the extension uses, from MDN's compatibility data: CSS anchor positioning, which
 * places the Why? popover and the coach mark (`anchor-name`, `position-area`, `position-try-fallbacks`), came in 147.
 * Everything else is older: data-collection consent 140, optional host permissions 128, `runtime.getContexts` 127,
 * `@starting-style` and `transition-behavior` 129, popovers 125, `AbortSignal.any` 124, `storage.session` 115 and
 * declarativeNetRequest 113. ESR 153 and every current release qualify.
 */
export const FIREFOX_MIN_VERSION = '147.0';

/**
 * Firefox's sidebar keyboard shortcut. None of Firefox's own shortcuts is Alt+Shift and a letter; on a Mac,
 * Option+Shift types characters, so it is Control+Shift there.
 */
export const SIDEBAR_SHORTCUT = { default: 'Alt+Shift+U', mac: 'MacCtrl+Shift+U' };
/** The toolbar icon, for Firefox's sidebar switcher. */
export const SIDEBAR_ICONS = { 16: 'icon/16.png', 32: 'icon/32.png' };

function hostPermissions(mode: string, browser: string): string[] {
  return [
    'https://www.linkedin.com/*',
    'https://www.facebook.com/*',
    // The e2e sign-in tab reports the URL it is sent back to only to a host permission for that address (CL1-16), in
    // Chrome and Edge. Anthropic and OpenAI are asked for at setup everywhere else, Brave from the web search key's
    // Save click; Playwright can't answer those prompts (P3-09, P3-47).
    ...(mode === 'e2e'
      ? [
          'http://127.0.0.1/*',
          ...(browser === 'firefox' ? [] : [`https://${devKey.id}.chromiumapp.org/*`]),
          ANTHROPIC_HOST,
          OPENAI_HOST,
          BRAVE_SEARCH_HOST,
        ]
      : []),
  ];
}

/** The manifest for a build mode and browser (Chrome and Edge share one). Pure, so tests can check every pair. */
export function manifestFor(mode: string, browser = 'chrome'): UserManifest {
  const e2e = mode === 'e2e';
  if (browser === 'firefox') {
    return {
      name: '__MSG_extName__',
      short_name: 'unAlgorithm',
      description: '__MSG_extDescription__',
      default_locale: 'en',
      homepage_url: 'https://unalgorithmfeed.com/',
      browser_specific_settings: {
        gecko: {
          // The store ID is permanent once the add-on is on AMO: servers key devices and the sign-in redirect to it.
          id: mode === 'production' ? FIREFOX_ADDON_ID : FIREFOX_DEV_ADDON_ID,
          strict_min_version: FIREFOX_MIN_VERSION,
          // Rules only sends nothing. Turning on any AI source but on-device, or saving a web search key, asks for post
          // text (websiteContent, personalCommunications) from the same click. technicalAndInteraction, which Firefox
          // offers at install and unAlgorithm never asks for, is declared in every build (ADR 0009 §5): it decides
          // whether Report a problem posts a report or offers to email it, and whether a sign-in sends the device
          // name. Only builds with the server card declare the rest: signing in to an unAlgorithm server asks for post
          // text, the people sync carries and the account (personallyIdentifyingInfo, authenticationInfo). A service
          // on this computer is asked for like any other (`src/lib/data-consent.ts`).
          data_collection_permissions: {
            required: ['none'],
            optional: [
              'websiteContent',
              'personalCommunications',
              'technicalAndInteraction',
              ...(cloudEnabled(mode) ? ['personallyIdentifyingInfo', 'authenticationInfo'] : []),
            ],
          },
        },
      },
      // Firefox can't make `identity`, `alarms` or declarativeNetRequestWithHostAccess optional, and shows no prompt
      // for any of them. `scripting` stays out: Firefox puts the content scripts on open tabs itself at install.
      permissions: ['storage', 'declarativeNetRequestWithHostAccess', ...(cloudEnabled(mode) ? ['alarms', 'identity'] : [])],
      host_permissions: hostPermissions(mode, browser),
      optional_host_permissions: ['https://*/*', 'http://*/*'],
      // Starts on the toolbar rather than in the Extensions panel.
      action: { default_title: 'unAlgorithm', default_area: 'navbar' },
      // Opens Highlights. A shortcut is a user action, which `sidebarAction.open()` needs.
      commands: { _execute_sidebar_action: { suggested_key: SIDEBAR_SHORTCUT } },
      // Firefox's default adds `upgrade-insecure-requests`, which would send http:// local AI and self-hosted servers
      // to https.
      content_security_policy: { extension_pages: "script-src 'self'" },
    };
  }
  // `identity` opens a server's sign-in page (`launchWebAuthFlow`); the server card asks for it from the click that
  // starts a sign-in. Playwright can't answer that prompt, so e2e builds have it from the start.
  const identity = cloudEnabled(mode) && !e2e ? ['identity' as const] : [];
  return {
    name: '__MSG_extName__',
    short_name: 'unAlgorithm',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    minimum_chrome_version: '130',
    homepage_url: 'https://unalgorithmfeed.com/',
    // `alarms` keeps settings sync on its 30-second rhythm (CL3-20); store builds without the server card leave it out.
    permissions: ['storage', 'sidePanel', 'scripting', ...(cloudEnabled(mode) ? ['alarms'] : []), ...(e2e ? ['identity'] : [])],
    host_permissions: hostPermissions(mode, browser),
    // AI endpoints are requested at setup, one origin at a time, from a click. Servers are reached through CORS
    // (ADR 0004).
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    optional_permissions: ['declarativeNetRequestWithHostAccess', ...identity],
    action: { default_title: 'unAlgorithm' },
    ...(mode === 'production' ? {} : { key: devKey.key }),
  };
}

const ENTRYPOINTS = resolve(import.meta.dirname, 'src/entrypoints');
const ZOD_JITLESS = resolve(import.meta.dirname, 'src/lib/zod-jitless.ts').replaceAll('\\', '/');

/** An entrypoint's own module: the background, a content script, or a page's `main.tsx`. */
export function isEntrypointModule(id: string): boolean {
  const path = relative(ENTRYPOINTS, id.split('?')[0] ?? '').replaceAll('\\', '/');
  return /^(background\.ts|[^/]+\.content\/index\.ts|[^/]+\/main\.tsx)$/.test(path);
}

export default defineConfig({
  srcDir: 'src',
  imports: false,
  modules: ['@wxt-dev/module-react'],
  targetBrowsers: ['chrome', 'edge', 'firefox'],
  // WXT would build Firefox as MV2 otherwise.
  manifestVersion: 3,
  // UA_LICENSES=1 builds the production bundle with source maps into its own folder, so
  // scripts/third-party-notices.mjs can list exactly what ships.
  ...(licenses ? { outDirTemplate: '{{browser}}-mv{{manifestVersion}}-licenses' } : {}),
  ...(sideload && !licenses ? { outDirTemplate: '{{browser}}-mv{{manifestVersion}}-sideload' } : {}),
  vite: (env) => ({
    resolve: { dedupe: ['react', 'react-dom', 'zod'] },
    build: { sourcemap: licenses },
    define: {
      'import.meta.env.UA_CLOUD': JSON.stringify(cloudEnabled(env.mode)),
      'import.meta.env.UA_REPORTS_URL': JSON.stringify(reportsUrlFor(env.mode)),
    },
    plugins: [
      {
        // src/lib/zod-jitless.ts runs before anything else in every entrypoint. Same line, so no line moves.
        name: 'unalgorithm:zod-jitless',
        transform(code: string, id: string) {
          return isEntrypointModule(id) ? { code: `import ${JSON.stringify(ZOD_JITLESS)};${code}`, map: null } : undefined;
        },
      },
    ],
  }),
  hooks: {
    'build:manifestGenerated': (wxt, manifest) => {
      if (sideload) Object.assign(manifest, sideloadManifest(manifest, wxt.config.browser, wxt.config.mode));
    },
    // Every zip carries the licence and the notices for the bundled open-source code.
    'build:publicAssets': (_wxt, files) => {
      files.push(
        { absoluteSrc: resolve(import.meta.dirname, '../../LICENSE'), relativeDest: 'LICENSE.txt' },
        { absoluteSrc: resolve(import.meta.dirname, '../../THIRD_PARTY_NOTICES.md'), relativeDest: 'THIRD_PARTY_NOTICES.md' },
      );
    },
    // Firefox's sidebar comes from the sidepanel entrypoint. Firefox opens a new add-on's sidebar at install unless
    // told not to, and onboarding already opens a tab; the icon labels it in the sidebar switcher.
    'entrypoints:resolved': (_wxt, entrypoints) => {
      for (const e of entrypoints)
        if (e.type === 'sidepanel') Object.assign(e.options, { openAtInstall: false, defaultIcon: SIDEBAR_ICONS });
    },
  },
  manifest: ({ mode, browser }) => manifestFor(mode, browser),
  webExt: {
    binaries: {
      ...(devChrome ? { chrome: devChrome } : {}),
      ...(process.env.UA_FIREFOX ? { firefox: process.env.UA_FIREFOX } : {}),
      ...(devEdge ? { edge: devEdge } : {}),
    },
    chromiumProfile: devProfile,
    firefoxProfile: devFirefoxProfile,
    keepProfileChanges: true,
    startUrls: [startUrl],
  },
  zip: {
    // The sideload build (`UA_SIDELOAD=1 wxt zip`) zips Chrome's, which Chrome and Edge both load.
    artifactTemplate: sideload ? 'unalgorithm-{{version}}-sideload.zip' : 'unalgorithm-{{version}}-{{browser}}.zip',
    // The Firefox zip comes with its sources for AMO's review: from the repository root, since the extension builds
    // from the workspace packages, the lockfile and the licence files the build copies in.
    sourcesTemplate: 'unalgorithm-{{version}}-sources.zip',
    sourcesRoot: resolve(import.meta.dirname, '../..'),
    includeSources: [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.npmrc',
      '.nvmrc',
      '.pnpmfile.cjs',
      'tsconfig.base.json',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'README.md',
      // How a reviewer builds it.
      'docs/amo-build.md',
      'apps/extension/**',
      'packages/**',
    ],
    // Dot folders never match (`dotSources` is off), so the dev profiles in apps/extension/.wxt, which hold sign-ins,
    // and the build output stay out; CI lists the zip to check (scripts/check-firefox-sources.mjs). The zip doesn't
    // read .gitignore, so the local leftovers it lists are named too: test and coverage reports, logs, `.local` files.
    excludeSources: [
      'apps/extension/e2e/**',
      'apps/extension/tests/**',
      'packages/*/test/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/coverage/**',
      '**/*.log',
      '**/*.local',
    ],
  },
});
