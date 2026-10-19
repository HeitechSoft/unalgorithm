/**
 * One manifest per build mode and browser (ADR 0008). Chrome and Edge share theirs. Firefox gets its add-on ID and
 * data-collection consent (technical and interaction data in every build, for problem reports; ADR 0009 §5), and has
 * the permissions it can't make optional (`identity`, `alarms`, declarativeNetRequestWithHostAccess) from the install,
 * a sidebar instead of the side panel, and a content security policy that leaves http:// AI servers alone. Every
 * entrypoint loads zod's jitless setting first. Only e2e builds send problem reports anywhere but unAlgorithm Cloud.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  clientKind,
  DEV_CHROMIUM_ID,
  FIREFOX_ADDON_ID,
  FIREFOX_DEV_ADDON_ID,
  GeckoIdSchema,
  REPORTS_PATH,
} from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CLOUD_DATA, DEVICE_NAME_DATA, POST_DATA, REPORT_DATA } from '../src/lib/data-consent.ts';
import config, {
  ANTHROPIC_HOST,
  BRAVE_SEARCH_HOST,
  E2E_REPORTS_URL,
  FIREFOX_MIN_VERSION,
  isEntrypointModule,
  manifestFor,
  OPENAI_HOST,
  reportsUrlFor,
  SIDEBAR_ICONS,
} from '../wxt.config.ts';

const MODES = ['production', 'development', 'e2e'];
const CLOUD_FLAGS = [undefined, '1'];

/**
 * Firefox's manifest schema (addons-linter's copy of it, and MDN's compatibility data): these are valid only as
 * required permissions, and Firefox drops them from `optional_permissions` with a warning.
 */
const FIREFOX_REQUIRED_ONLY = ['identity', 'alarms', 'storage', 'unlimitedStorage', 'declarativeNetRequestWithHostAccess'];
/** Chromium-only permissions, which Firefox doesn't know. */
const CHROMIUM_ONLY = ['sidePanel'];

const permissionsOf = (m: ReturnType<typeof manifestFor>) => [...(m.permissions ?? []), ...(m.optional_permissions ?? [])];

/** Every combination of the Cloud flag and build mode, with the flag set while `run` runs. */
function eachBuild(run: (mode: string, cloud: boolean) => void) {
  for (const flag of CLOUD_FLAGS) {
    vi.stubEnv('UA_CLOUD', flag);
    for (const mode of MODES) run(mode, flag === '1' || mode !== 'production');
  }
  vi.unstubAllEnvs();
}

afterEach(() => vi.unstubAllEnvs());

describe('manifest per browser', () => {
  it('test_edge_manifest_is_chrome_manifest', () => {
    eachBuild((mode) => {
      expect(manifestFor(mode, 'edge'), mode).toEqual(manifestFor(mode, 'chrome'));
      // Chrome is the default target, as in WXT.
      expect(manifestFor(mode), mode).toEqual(manifestFor(mode, 'chrome'));
    });
  });

  it('test_chrome_manifest_keeps_its_keys', () => {
    eachBuild((mode, cloud) => {
      const m = manifestFor(mode, 'chrome');
      expect(m.minimum_chrome_version).toBe('130');
      expect(m.permissions?.slice(0, 3)).toEqual(['storage', 'sidePanel', 'scripting']);
      expect(m.optional_permissions?.[0]).toBe('declarativeNetRequestWithHostAccess');
      expect(m.permissions?.includes('alarms')).toBe(cloud);
      expect(m.action).toEqual({ default_title: 'unAlgorithm' });
      for (const key of ['browser_specific_settings', 'commands', 'content_security_policy']) expect(m).not.toHaveProperty(key);
      if (mode === 'production') expect(m).not.toHaveProperty('key');
      else expect(m.key).toMatch(/^MIIB/);
    });
    // The dev key gives Chrome and Edge the ID servers accept by default.
    const devKey = JSON.parse(readFileSync(resolve(import.meta.dirname, '../dev-key.json'), 'utf8')) as { id: string };
    expect(devKey.id).toBe(DEV_CHROMIUM_ID);
    expect(manifestFor('e2e', 'edge').host_permissions).toContain(`https://${DEV_CHROMIUM_ID}.chromiumapp.org/*`);
  });

  it('test_firefox_manifest_ids', () => {
    eachBuild((mode) => {
      const m = manifestFor(mode, 'firefox');
      const gecko = m.browser_specific_settings?.gecko;
      expect(gecko?.id, mode).toBe(mode === 'production' ? FIREFOX_ADDON_ID : FIREFOX_DEV_ADDON_ID);
      expect(GeckoIdSchema.safeParse(gecko?.id).success).toBe(true);
      expect(clientKind(gecko?.id ?? '')).toBe('gecko');
      // A Chromium key or version means nothing to Firefox.
      expect(m).not.toHaveProperty('key');
      expect(m).not.toHaveProperty('minimum_chrome_version');
      expect(gecko?.strict_min_version).toBe(FIREFOX_MIN_VERSION);
    });
    expect(FIREFOX_ADDON_ID).not.toBe(FIREFOX_DEV_ADDON_ID);
    // Firefox's built-in data-collection consent needs 140; CSS anchor positioning needs 147.
    expect(FIREFOX_MIN_VERSION).toBe('147.0');
    expect(Number.parseFloat(FIREFOX_MIN_VERSION)).toBeGreaterThanOrEqual(140);
  });

  it('test_firefox_permissions_it_cannot_make_optional_are_required', () => {
    eachBuild((mode, cloud) => {
      const m = manifestFor(mode, 'firefox');
      const why = `${mode} cloud=${cloud}`;
      expect(m.permissions, why).toEqual([
        'storage',
        'declarativeNetRequestWithHostAccess',
        ...(cloud ? ['alarms', 'identity'] : []),
      ]);
      expect(m, why).not.toHaveProperty('optional_permissions');
      for (const p of m.optional_permissions ?? []) expect(FIREFOX_REQUIRED_ONLY, p).not.toContain(p);
      // No side panel (Firefox has a sidebar), and no `scripting`: Firefox puts the content scripts on open tabs itself.
      for (const p of [...CHROMIUM_ONLY, 'scripting']) expect(permissionsOf(m), why).not.toContain(p);
      // The same permissions as Chrome and Edge otherwise, only required.
      const chromium = permissionsOf(manifestFor(mode, 'chrome')).filter((p) => !['sidePanel', 'scripting'].includes(p));
      expect([...permissionsOf(m)].sort(), why).toEqual(
        [...new Set([...chromium, 'declarativeNetRequestWithHostAccess'])].sort(),
      );
    });
  });

  it('test_firefox_data_collection', () => {
    eachBuild((mode, cloud) => {
      const why = `${mode} cloud=${cloud}`;
      // Rules only sends nothing; the rest is asked for from the click that turns it on. Technical and interaction
      // data, which Firefox offers at install and unAlgorithm never asks for, is declared in every build: problem
      // reports are sent only while it is allowed (ADR 0009 §5). Only builds with the server card declare the server's
      // types, which Firefox would otherwise offer at install for nothing.
      const declared = manifestFor(mode, 'firefox').browser_specific_settings?.gecko?.data_collection_permissions;
      expect(declared, why).toEqual({
        required: ['none'],
        optional: cloud
          ? [
              'websiteContent',
              'personalCommunications',
              'technicalAndInteraction',
              'personallyIdentifyingInfo',
              'authenticationInfo',
            ]
          : ['websiteContent', 'personalCommunications', 'technicalAndInteraction'],
      });
      expect(declared?.optional, why).toContain('technicalAndInteraction');
      // Exactly the types the build's code uses: Firefox refuses a request for a type the manifest doesn't declare,
      // and a declared type nothing uses would be offered for nothing. Post text and problem reports (only read) in
      // every build; the server's set, asked for in the sign-in click, and the device name's, only read, with the
      // server card.
      const used = cloud ? [...POST_DATA, ...REPORT_DATA, ...CLOUD_DATA, ...DEVICE_NAME_DATA] : [...POST_DATA, ...REPORT_DATA];
      expect([...new Set(used)].sort(), why).toEqual([...(declared?.optional ?? [])].sort());
    });
  });

  it('test_only_e2e_builds_send_reports_elsewhere', () => {
    for (const mode of ['production', 'development']) expect(reportsUrlFor(mode), mode).toBeNull();
    expect(reportsUrlFor('e2e')).toBe(E2E_REPORTS_URL);
    // The test server on this computer, on the port the report specs start it on.
    const url = new URL(E2E_REPORTS_URL);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe(REPORTS_PATH);
    const harness = readFileSync(resolve(import.meta.dirname, '../e2e/server-harness.ts'), 'utf8');
    expect(harness).toContain(`export const E2E_REPORTS_PORT = ${url.port};`);
    // The build defines it for every mode, so a production bundle folds it away.
    const vite = config.vite as (env: unknown) => { define: Record<string, string> };
    expect(vite({ mode: 'production', browser: 'chrome' }).define['import.meta.env.UA_REPORTS_URL']).toBe('null');
    expect(vite({ mode: 'e2e', browser: 'firefox' }).define['import.meta.env.UA_REPORTS_URL']).toBe(
      JSON.stringify(E2E_REPORTS_URL),
    );
  });

  it('test_firefox_toolbar_sidebar_shortcut_and_csp', () => {
    eachBuild((mode) => {
      const m = manifestFor(mode, 'firefox');
      expect(m.action).toEqual({ default_title: 'unAlgorithm', default_area: 'navbar' });
      expect(m.commands).toEqual({
        _execute_sidebar_action: { suggested_key: { default: 'Alt+Shift+U', mac: 'MacCtrl+Shift+U' } },
      });
      // Firefox's own default adds `upgrade-insecure-requests`, which would send http:// AI servers to https.
      expect(m.content_security_policy).toEqual({ extension_pages: "script-src 'self'" });
      expect(JSON.stringify(m)).not.toContain('upgrade-insecure-requests');
    });
  });

  it('test_firefox_hosts', () => {
    eachBuild((mode) => {
      const firefox = manifestFor(mode, 'firefox');
      const chrome = manifestFor(mode, 'chrome');
      expect(firefox.optional_host_permissions).toEqual(chrome.optional_host_permissions);
      if (mode !== 'e2e') {
        expect(firefox.host_permissions).toEqual(chrome.host_permissions);
        return;
      }
      // The Chromium sign-in redirect host is Chrome's and Edge's only.
      expect(firefox.host_permissions).toEqual(
        chrome.host_permissions?.filter((h) => !/^https:\/\/[a-p]{32}\.chromiumapp\.org\/\*$/.test(h)),
      );
      expect(firefox.host_permissions).toEqual(
        expect.arrayContaining(['http://127.0.0.1/*', ANTHROPIC_HOST, OPENAI_HOST, BRAVE_SEARCH_HOST]),
      );
      expect(firefox.host_permissions?.join(' ')).not.toMatch(/chromiumapp|allizom/);
    });
  });

  it('test_firefox_sidebar_does_not_open_at_install', async () => {
    const sidepanel = { type: 'sidepanel', options: { defaultTitle: 'unAlgorithm Highlights' } };
    const popup = { type: 'popup', options: {} };
    const hooks = config.hooks as Record<string, (wxt: unknown, entrypoints: unknown[]) => unknown>;
    const hook = hooks['entrypoints:resolved'] as (wxt: unknown, entrypoints: unknown[]) => unknown;
    await hook({}, [sidepanel, popup]);
    expect(sidepanel.options).toEqual({
      defaultTitle: 'unAlgorithm Highlights',
      openAtInstall: false,
      defaultIcon: SIDEBAR_ICONS,
    });
    expect(popup.options).toEqual({});
  });
});

describe('zod jitless', () => {
  const ENTRYPOINTS = resolve(import.meta.dirname, '../src/entrypoints');

  /** Each entrypoint's own module: the background, a content script's index, or the script a page's HTML loads. */
  function entryModules(): string[] {
    const found: string[] = [];
    for (const name of readdirSync(ENTRYPOINTS)) {
      const path = join(ENTRYPOINTS, name);
      if (!statSync(path).isDirectory()) found.push(path);
      else if (name.endsWith('.content')) found.push(join(path, 'index.ts'));
      else {
        const html = readFileSync(join(path, 'index.html'), 'utf8');
        for (const [, src] of html.matchAll(/<script type="module" src="\.\/([^"]+)"/g)) found.push(join(path, src ?? ''));
      }
    }
    return found;
  }

  it('test_every_entrypoint_loads_zod_jitless_first', () => {
    const modules = entryModules();
    // background, two content scripts, five pages (the report page among them).
    expect(modules).toHaveLength(8);
    const vite = config.vite as (env: unknown) => { plugins: { name?: string }[] };
    const plugin = vite({ mode: 'production', browser: 'firefox' }).plugins.find(
      (p) => p.name === 'unalgorithm:zod-jitless',
    ) as unknown as { transform: (code: string, id: string) => { code: string; map: null } | undefined };
    for (const id of modules) {
      expect(isEntrypointModule(id), id).toBe(true);
      const out = plugin.transform('import { z } from "zod";\nz.object({});', `${id}?v=1`);
      // Ahead of everything else, on the same line, so no line moves.
      expect(out?.code, id).toMatch(/^import ".*\/src\/lib\/zod-jitless\.ts";import \{ z \} from "zod";\nz\.object\(\{\}\);$/);
    }
    for (const id of [
      join(ENTRYPOINTS, 'popup/App.tsx'),
      join(ENTRYPOINTS, '../lib/storage.ts'),
      join(ENTRYPOINTS, 'linkedin.content/other.ts'),
      resolve(ENTRYPOINTS, '../../../../packages/protocol/src/index.ts'),
      '\0virtual:wxt-background-entrypoint?/x/background.ts',
    ]) {
      expect(isEntrypointModule(id), id).toBe(false);
      expect(plugin.transform('x', id)).toBeUndefined();
    }
  });

  it('test_zod_jitless_module', async () => {
    expect(z.config().jitless).not.toBe(true);
    await import('../src/lib/zod-jitless.ts');
    expect(z.config().jitless).toBe(true);
    z.config({ jitless: false });
  });
});
