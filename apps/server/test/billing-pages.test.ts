/**
 * What the billing host gives a module's own pages (CL5-03): the server's frame and stylesheet under its strict CSP,
 * escaped HTML only, the signed-in person without a 401, the Origin check for a form POST, the money wording, and a
 * body limit for every request outside `/v1` and `/api/auth`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatPrice } from '@unalgorithm/core';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { BillingHost, BillingModule } from '../src/billing/host.ts';
import { noopBilling } from '../src/billing/provider.ts';
import type { AppEnv } from '../src/http/app.ts';
import type { ModulePage } from '../src/http/page-frame.ts';
import { pageCsp, webStylesheets } from '../src/http/page-frame.ts';
import * as fixtureModule from './fixtures/billing-module/index.ts';
import { signInDevice, signInWeb } from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const TOM = 'tom@example.com';
const SOURCE_URL = 'https://example.org/unalgorithm-source';
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const INDEX_HTML =
  '<!doctype html><html><head><title>Web</title><script type="module" crossorigin src="/assets/index-a1b2.js"></script>' +
  '<link rel="stylesheet" crossorigin href="/assets/index-AbC1.css"></head><body><div id="root"></div></body></html>\n';

/** Folders and apps a test made, removed and closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function webDist(index: string | null = INDEX_HTML): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ua-pages-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  if (index !== null) await writeFile(join(dir, 'index.html'), index);
  return dir;
}

/** What a test route renders as `main`: the default escapes `'<b>&'`. */
type MainOf = (host: BillingHost) => ModulePage['main'];

/** A module whose `mount` adds `/billing/test-page` (GET renders, POST behind `ownPage`) and `/billing/who`. */
function pagesModule(main: MainOf = (host) => host.html`<p>${'<b>&'}</p>`): BillingModule {
  return {
    async createBillingProvider(host) {
      return {
        ...noopBilling,
        id: 'pages',
        mount(app: Hono<AppEnv>) {
          app.get('/billing/test-page', (c) =>
            host.pages.render(c, { title: 'Add credit', intro: 'Pay as you go.', main: main(host) }),
          );
          app.post('/billing/test-page', host.auth.ownPage, async (c) => {
            const body = await c.req.text();
            return host.pages.render(c, { title: 'Sent', intro: 'Done.', main: host.html`<p>${body.length}</p>` });
          });
          app.get('/billing/who', async (c) => {
            const user = await host.auth.webUser(c);
            if (!user) return c.redirect('/', 303);
            return c.json(user);
          });
        },
      };
    },
  };
}

async function pagesApp(opts: { main?: MainOf; index?: string | null } = {}) {
  const dist = await webDist(opts.index);
  const t = await createTestApp({
    config: testConfig({ WEB_DIST: dist, SOURCE_URL, SIGNUP_ALLOWLIST: TOM }),
    billingModule: pagesModule(opts.main),
  });
  cleanup.push(t.close);
  return t;
}

describe('frame', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_page_csp_default_and_form_actions', () => {
    expect(pageCsp()).toBe(CSP);
    expect(pageCsp([])).toBe(CSP);
    expect(pageCsp(['https://checkout.stripe.com'])).toBe(`${CSP} https://checkout.stripe.com`);
    expect(pageCsp(['https://checkout.stripe.com'])).toMatch(/form-action 'self' https:\/\/checkout\.stripe\.com$/);
    expect(pageCsp(['https://pay.example:8443'])).toMatch(/form-action 'self' https:\/\/pay\.example:8443$/);
    for (const bad of ['http://x.example', 'https://x.example/path', 'https://x.example; script-src *', 'https://X.example']) {
      expect(() => pageCsp([bad]), bad).toThrow(TypeError);
    }
  });

  it('test_web_stylesheets_only_hashed_assets', () => {
    const index =
      '<!doctype html><head><link rel="stylesheet" crossorigin href="/assets/index-AbC1.css">' +
      '<script type="module" src="/assets/index-x.js"></script>' +
      '<link rel="stylesheet" href="https://cdn.example/x.css">' +
      '<link rel="stylesheet" href="/assets/../x.css">' +
      '<link rel="preload" href="/assets/font-1.css"></head>';
    expect(webStylesheets(index)).toEqual(['/assets/index-AbC1.css']);
    expect(webStylesheets('<link href="/assets/b-2.css" rel="stylesheet"><link rel=stylesheet href=/assets/c-3.css>')).toEqual([
      '/assets/b-2.css',
      '/assets/c-3.css',
    ]);
  });

  it('test_module_page_frame_escaped_and_styled', async () => {
    const t = await pagesApp();
    const res = await t.app.request('/billing/test-page');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toBe('text/html; charset=UTF-8');
    const body = await res.text();
    expect(body).toContain('<title>Add credit · Test server</title>');
    expect(body).toContain('<meta name="referrer" content="same-origin">');
    expect(body).toContain('<link rel="stylesheet" href="/assets/index-AbC1.css">');
    expect(body).toContain('<p>&lt;b&gt;&amp;</p>');
    expect(body).toContain('<h1>Test server</h1><p>Pay as you go.</p>');
    expect(body).toContain(`<a href="${SOURCE_URL}" target="_blank" rel="noreferrer">Source</a>`);
    expect(body).toMatch(/class="web-page".*class="web-main".*class="web-header".*class="web-footer"/s);
    expect(body).not.toContain('<script');
    expect(body).not.toContain('index-a1b2.js');
  });

  it('test_module_page_without_web_build_503', async () => {
    const t = await pagesApp({ index: null });
    for (let i = 0; i < 2; i++) {
      const res = await t.app.request('/billing/test-page');
      expect(res.status).toBe(503);
      expect(await res.text()).toBe('Build apps/web first');
    }
    expect(t.events().filter((e) => e.event === 'web.missing')).toHaveLength(1);
  });

  it('test_module_page_refuses_unescaped_main', async () => {
    const mains: MainOf[] = [
      () => '<p>x</p>' as unknown as ModulePage['main'],
      () => Promise.resolve('<p>x</p>') as unknown as ModulePage['main'],
    ];
    for (const main of mains) {
      const t = await pagesApp({ main });
      const res = await t.app.request('/billing/test-page');
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ code: 'unknown' });
      expect(t.events().find((e) => e.event === 'http.error')).toMatchObject({ err_name: 'TypeError' });
      await expect(
        t.host.pages.render({} as Parameters<BillingHost['pages']['render']>[0], {
          title: 't',
          intro: 'i',
          main: main(t.host),
        }),
      ).rejects.toThrow(new TypeError('page.main must be built with host.html'));
    }
  });
});

describe('auth', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_host_web_user_cookie_only', async () => {
    const t = await pagesApp();
    const cookie = await signInWeb(t.app, t.outbox, TOM);
    const signedIn = await t.app.request('/billing/who', { headers: { Cookie: cookie } });
    expect(signedIn.status).toBe(200);
    const user = (await signedIn.json()) as Record<string, unknown>;
    expect(Object.keys(user).sort()).toEqual(['email', 'userId']);
    expect(user).toMatchObject({ email: TOM, userId: expect.any(String) });

    const signedOut = await t.app.request('/billing/who');
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get('location')).toBe('/');

    const tokens = await signInDevice(t.app, t.outbox, TOM);
    const bearer = await t.app.request('/billing/who', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    expect(bearer.status).toBe(303);
  });

  it('test_host_own_page_checks_origin', async () => {
    const t = await pagesApp();
    const post = (headers: Record<string, string>) => t.app.request('/billing/test-page', { method: 'POST', headers, body: 'x' });
    const refused: Record<string, string>[] = [{}, { Origin: 'https://elsewhere.example' }, { Origin: 'null' }];
    for (const headers of refused) {
      const res = await post(headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'permission' });
    }
    const own = await post({ Origin: TEST_PUBLIC_URL });
    expect(own.status).toBe(200);
    expect(await own.text()).toContain('<p>1</p>');
  });

  it('test_fixture_module_form_page', async () => {
    const t = await createTestApp({ config: testConfig({ WEB_DIST: await webDist() }), billingModule: fixtureModule });
    cleanup.push(t.close);
    const page = await (await t.app.request('/billing/fixture-form')).text();
    expect(page).toContain('<form method="post" action="/billing/fixture-form">');
    expect(page).not.toContain('<script');
    const form = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' };
    expect((await t.app.request('/billing/fixture-form', form)).status).toBe(403);
    const sent = await t.app.request('/billing/fixture-form', { ...form, headers: { ...form.headers, Origin: TEST_PUBLIC_URL } });
    expect(sent.status).toBe(200);
    expect(await sent.text()).toContain('<p>Form received.</p>');
  });
});

describe('limits and wording', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_page_body_limit_outside_v1', async () => {
    const t = await pagesApp();
    const post = (bytes: number) =>
      t.app.request('/billing/test-page', { method: 'POST', headers: { Origin: TEST_PUBLIC_URL }, body: 'x'.repeat(bytes) });
    const big = await post(16 * 1024 + 1);
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ code: 'bad-request', message: 'The request was too large.' });
    const fits = await post(16 * 1024);
    expect(fits.status).toBe(200);
    expect(await fits.text()).toContain(`<p>${16 * 1024}</p>`);
    // `/v1` keeps its own 128 KiB rule: 100 KiB goes on to routing (404).
    const v1 = await t.app.request('/v1/anything', { method: 'POST', body: 'x'.repeat(100 * 1024) });
    expect(v1.status).toBe(404);
  });

  it('test_host_format_is_core_wording', async () => {
    const t = await pagesApp();
    expect(t.host.format.formatBalance(4_200_000)).toBe('$4.20');
    expect(t.host.format.formatPrice).toBe(formatPrice);
  });
});
