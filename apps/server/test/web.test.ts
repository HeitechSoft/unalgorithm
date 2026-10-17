/**
 * The server serves its web app (apps/web) from its own origin: `/`, `/authorize`, `/account`, `/setup`, `/admin` and
 * `/outlets` answer the built `index.html` under a strict CSP, `/assets/*` the built files, and a server without a build says so instead.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNT_PAGE_PATH, ADMIN_PAGE_PATH, OUTLETS_PAGE_PATH, SETUP_PAGE_PATH } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const INDEX_HTML =
  '<!doctype html><title>Sign in</title><div id="root"></div><script type="module" src="/assets/index-a1b2c3.js"></script>\n';
const ASSET = 'document.title = "built";\n';

/** Folders and apps a test made, removed and closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ua-web-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function webApp(webDist: string) {
  const t = await createTestApp({ config: testConfig({ WEB_DIST: webDist }) });
  cleanup.push(t.close);
  return t;
}

describe('static serving', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_authorize_page_served_with_csp', async () => {
    const dist = await tempDir();
    await mkdir(join(dist, 'assets'));
    await writeFile(join(dist, 'index.html'), INDEX_HTML);
    await writeFile(join(dist, 'assets', 'index-a1b2c3.js'), ASSET);
    const t = await webApp(dist);

    for (const path of ['/authorize?x=1', '/']) {
      const page = await t.app.request(path);
      expect(page.status, path).toBe(200);
      expect(page.headers.get('content-type')).toMatch(/^text\/html/);
      expect(page.headers.get('content-security-policy')).toBe(CSP);
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(await page.text()).toBe(INDEX_HTML);
    }

    const asset = await t.app.request('/assets/index-a1b2c3.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toMatch(/^text\/javascript/);
    // Vite names every asset by its content hash, so a cached copy never goes stale.
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await asset.text()).toBe(ASSET);

    // Only the build's assets: nothing outside the folder, and no listing.
    for (const path of ['/assets/missing.js', '/assets/..%2Findex.html', '/assets/', '/index.html']) {
      expect((await t.app.request(path)).status, path).toBe(404);
    }
  });

  it('test_missing_web_build_503', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const empty = await tempDir();
    const t = await webApp(empty);

    for (const path of ['/authorize', '/']) {
      const res = await t.app.request(path);
      expect(res.status, path).toBe(503);
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
      expect(await res.text()).toBe('Build apps/web first');
    }
    expect((await t.app.request('/assets/index-a1b2c3.js')).status).toBe(404);
    // Said once, in the server's own log format.
    expect(t.events().filter((e) => e.event === 'web.missing')).toHaveLength(1);

    // A folder that does not exist at all is the same, and nothing is written outside the log.
    const none = await webApp(join(empty, 'dist'));
    expect((await none.app.request('/authorize')).status).toBe(503);
    expect((await none.app.request('/assets/index-a1b2c3.js')).status).toBe(404);
    expect(consoleError).not.toHaveBeenCalled();

    // Built later, it is served without a restart.
    await writeFile(join(empty, 'index.html'), INDEX_HTML);
    expect((await t.app.request('/authorize')).status).toBe(200);
  });
});

describe('pages', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_account_page_served', async () => {
    const dist = await tempDir();
    await writeFile(join(dist, 'index.html'), INDEX_HTML);
    const t = await webApp(dist);

    const home = await t.app.request('/');
    const page = await t.app.request(ACCOUNT_PAGE_PATH);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('content-security-policy')).toBe(CSP);
    expect(page.headers.get('content-security-policy')).toBe(home.headers.get('content-security-policy'));
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toBe(INDEX_HTML);

    // Without a build, the same answer as the other pages.
    const none = await webApp(join(await tempDir(), 'dist'));
    const missing = await none.app.request(ACCOUNT_PAGE_PATH);
    expect(missing.status).toBe(503);
    expect(missing.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await missing.text()).toBe('Build apps/web first');
  });

  it('test_setup_page_served_with_csp', async () => {
    const dist = await tempDir();
    await writeFile(join(dist, 'index.html'), INDEX_HTML);
    const t = await webApp(dist);

    // The setup link's token is in the fragment, which the browser never sends: the page is the same for every link.
    const page = await t.app.request(SETUP_PAGE_PATH);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('content-security-policy')).toBe(CSP);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toBe(INDEX_HTML);

    // Without a build, the same answer as the other pages.
    const none = await webApp(join(await tempDir(), 'dist'));
    const missing = await none.app.request(SETUP_PAGE_PATH);
    expect(missing.status).toBe(503);
    expect(await missing.text()).toBe('Build apps/web first');
  });

  it('test_admin_page_served_with_csp', async () => {
    const dist = await tempDir();
    await writeFile(join(dist, 'index.html'), INDEX_HTML);
    const t = await webApp(dist);

    // The page itself is public: what it shows comes from the admin routes, which check the role (CL4-05, CL4-06).
    const page = await t.app.request(ADMIN_PAGE_PATH);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('content-security-policy')).toBe(CSP);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toBe(INDEX_HTML);

    // Without a build, the same answer as the other pages.
    const none = await webApp(join(await tempDir(), 'dist'));
    const missing = await none.app.request(ADMIN_PAGE_PATH);
    expect(missing.status).toBe(503);
    expect(await missing.text()).toBe('Build apps/web first');
  });

  it('test_outlets_page_served_with_csp', async () => {
    const dist = await tempDir();
    await writeFile(join(dist, 'index.html'), INDEX_HTML);
    const t = await webApp(dist);

    // Public: no session, no cookie; the page reads the public list (P3-67).
    const page = await t.app.request(OUTLETS_PAGE_PATH);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('content-security-policy')).toBe(CSP);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.getSetCookie()).toEqual([]);
    expect(await page.text()).toBe(INDEX_HTML);

    // Without a build, the same answer as the other pages.
    const none = await webApp(join(await tempDir(), 'dist'));
    const missing = await none.app.request(OUTLETS_PAGE_PATH);
    expect(missing.status).toBe(503);
    expect(await missing.text()).toBe('Build apps/web first');
  });
});
