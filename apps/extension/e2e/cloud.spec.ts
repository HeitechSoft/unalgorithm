import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { type MockOpenAI, startMockOpenAI } from '@unalgorithm/ai/testing';
import {
  AUTHORIZE_PAGE_PATH,
  CLASSIFY_PATH,
  ClassifyRequestSchema,
  EMAIL_OTP_METHOD,
  MAX_POSTS_PER_REQUEST,
  SERVER_INFO_PATH,
  ServerInfoSchema,
  TOKEN_PATH,
} from '@unalgorithm/protocol';
import { FIRST_DEGREE_POST } from '../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { expect, test } from './fixtures.ts';
import { databaseExists, type LocalServer, startLocalServer } from './server-harness.ts';
import { signInFromSettings } from './server-sign-in.ts';

/**
 * The walking skeleton end to end (CL1): a fresh extension signs in to a real server process with an emailed code, and
 * the fixture feed is labelled by the mock AI provider through that server. Needs Postgres and Mailpit
 * (`apps/server/compose.dev.yaml` locally, service containers in CI) and the built `apps/web`, so it runs only with
 * `UA_SERVER_E2E=1`.
 */
const SKIP = process.env.UA_SERVER_E2E !== '1';
const NEEDS = 'needs Postgres and Mailpit';

const EMAIL = 'tester@example.com';
/** The first-degree fixture post's text and its author: the author never leaves the browser, the text never reaches a log. */
const POST_TEXT = 'Which HR task would you automate first';
const AUTHOR = 'Morgan Ellis';
const CLOUD = 'https://cloud.unalgorithm.app';
/** The balance pill's accessible name (CL2-12). */
const BALANCE_PILL = /^Credit balance:/;

test.describe('a self-hosted server', () => {
  test.skip(SKIP, NEEDS);

  let ai: MockOpenAI | undefined;
  let server: LocalServer | undefined;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    ai = await startMockOpenAI();
    server = await startLocalServer({ aiBaseUrl: ai.baseUrl });
  });

  // test_harness_cleans_up: afterAll runs when a test failed too.
  test.afterAll(async () => {
    test.setTimeout(60_000);
    try {
      await server?.stop();
    } finally {
      await ai?.close();
    }
    if (!server) return;
    expect(server.exited()).toBe(true);
    expect(server.database).toMatch(/^ua_e2e_[0-9a-f]{12}$/);
    expect(new URL(server.env.DATABASE_URL ?? '').pathname).toBe(`/${server.database}`);
    expect(await databaseExists(server.database)).toBe(false);
  });

  test('test_self_hosted_sign_in_and_labels', async ({ context, extensionId, feed }) => {
    test.setTimeout(120_000);
    if (!server || !ai) throw new Error('beforeAll did not start the server');
    const { url, logs } = server;
    const host = new URL(url).host;
    expect(FIRST_DEGREE_POST).toContain(POST_TEXT);
    expect(FIRST_DEGREE_POST).toContain(AUTHOR);

    const classifyBodies: string[] = [];
    await context.route('http://127.0.0.1:*/**', (route) => {
      if (new URL(route.request().url()).pathname === CLASSIFY_PATH) classifyBodies.push(route.request().postData() ?? '');
      return route.continue();
    });
    // Where the sign-in page sends the browser back; the extension reads the address from the tab and closes it.
    await context.route(`https://${extensionId}.chromiumapp.org/**`, (route) => route.fulfill({ status: 200, body: 'ok' }));

    // Sign in from Settings with the emailed code; the sign-in page is checked at its email and code steps.
    await signInFromSettings(context, extensionId, url, EMAIL, (step, page) =>
      test.step(`test_authorize_page_accessibility (${step} step)`, () => expectAccessible(page)),
    );

    // Privacy & Data names the server by its host, with the self-hosted recipient text.
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html#/privacy`);
    await expect(options.locator('.flow-box').last()).toHaveText(host);
    await expect(options.getByText(/not HeitechSoft/)).toContainText(host);

    // The feed, labelled by the mock provider through the server.
    const page = await feed();
    const friend = page.locator('[componentkey="update-card-focusEEEkeyFirstDegree5"]');
    await expect(friend).toHaveAttribute('data-unalgo-pick', '', { timeout: 20_000 });
    await expect(friend.locator('unalgo-post').getByText('For you')).toBeVisible();

    // Only masked post text and pk_ refs reach the server, nothing about the author; nothing of the post reaches a log.
    expect(classifyBodies.length).toBeGreaterThan(0);
    for (const body of classifyBodies) {
      const request = ClassifyRequestSchema.parse(JSON.parse(body));
      for (const post of request.posts) expect(post.ref).toMatch(/^pk_/);
      expect(body).not.toContain(AUTHOR);
      expect(body).not.toContain('linkedin.com/in/');
    }
    expect(ai.bodies.some((b) => b.includes(POST_TEXT))).toBe(true);
    for (const body of ai.bodies) {
      expect(body).not.toContain(AUTHOR);
      expect(body).not.toContain('linkedin.com/in/');
    }
    expect(logs()).not.toContain(POST_TEXT);
    expect(logs()).not.toContain(AUTHOR);

    // A server that doesn't bill shows no balance anywhere (R5): no pill in the popup or in Settings, no credit banner.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    // The footer names the server once `aiStatus` has answered, so what is absent below is absent from that answer.
    await expect(popup.getByText(`${host} · Ready`, { exact: true })).toBeVisible();
    await expect(popup.getByLabel(BALANCE_PILL)).toHaveCount(0);
    await expect(popup.getByText('Your balance is low', { exact: true })).toHaveCount(0);
    await expect(popup.getByText('AI is paused', { exact: true })).toHaveCount(0);
    await options.goto(`chrome-extension://${extensionId}/options.html#/ai`);
    await expect(options.getByText(`Signed in as ${EMAIL}`)).toBeVisible();
    expect(await options.evaluate(() => chrome.runtime.sendMessage({ type: 'aiStatus' }))).not.toHaveProperty('balance');
    await expect(options.getByLabel(BALANCE_PILL)).toHaveCount(0);
  });
});

test.describe('UnAlgorithm Cloud', () => {
  test.skip(SKIP, NEEDS);

  test('test_cloud_origin_labels_and_recipient', async ({ context, extensionId }) => {
    // No live Cloud: only its discovery document, served here.
    const info = ServerInfoSchema.parse({
      v: 1,
      name: 'UnAlgorithm Cloud',
      version: '0.1.0',
      source: 'https://github.com/HeitechSoft/unalgorithm',
      billing: false,
      capabilities: { classify: true, sync: false },
      auth: { methods: [EMAIL_OTP_METHOD], authorizePath: AUTHORIZE_PAGE_PATH, tokenPath: TOKEN_PATH },
      limits: { maxPostsPerRequest: MAX_POSTS_PER_REQUEST },
    });
    await context.route(`${CLOUD}${SERVER_INFO_PATH}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(info) }),
    );

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html#/ai`);
    const saved = await options.evaluate(
      (baseUrl) => chrome.runtime.sendMessage({ type: 'saveSource', config: { kind: 'server', baseUrl } }),
      CLOUD,
    );
    expect(saved).toMatchObject({ ok: true });

    await options.goto(`chrome-extension://${extensionId}/options.html#/privacy`);
    await expect(options.locator('.flow-box').last()).toHaveText('UnAlgorithm Cloud');
    const recipient = options.getByText(/^Post text goes from your browser to UnAlgorithm Cloud/);
    await expect(recipient).toContainText('HeitechSoft');
    await expect(recipient).toContainText('Anthropic');

    // Not signed in, so the popup asks for attention.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByText('UnAlgorithm Cloud · Needs attention', { exact: true })).toBeVisible();
  });
});

/** No serious or critical axe violations, as `a11y.spec.ts` checks the extension's own pages. Soft, so sign-in goes on. */
async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  const problems = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${v.id} (${v.impact}) ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join(' | ')}`,
    );
  expect.soft(problems, problems.join('\n')).toEqual([]);
}
