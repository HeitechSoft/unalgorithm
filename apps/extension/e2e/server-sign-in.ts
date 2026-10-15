import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { AUTHORIZE_PAGE_PATH } from '@unalgorithm/protocol';
import { expect } from './fixtures.ts';
import { clearMailbox, latestSignInCode } from './server-harness.ts';

/**
 * Lets the profile reach the local server and fulfils the `chromiumapp.org` address the server's sign-in page sends the
 * browser back to (the extension reads the address from the tab and closes it). `record` receives every request to
 * `http://127.0.0.1:*`: its URL and body (empty without one). The only copy of these routes for the server specs.
 */
export async function allowServer(
  context: BrowserContext,
  extensionId: string,
  record?: (url: string, body: string) => void,
): Promise<void> {
  await context.route('http://127.0.0.1:*/**', (route) => {
    const request = route.request();
    record?.(request.url(), request.postData() ?? '');
    return route.continue();
  });
  await context.route(`https://${extensionId}.chromiumapp.org/**`, (route) => route.fulfill({ status: 200, body: 'ok' }));
}

/**
 * Signs the extension in to a local server from Settings → AI, as a person does (CL1-20): the server card and its
 * address, who receives posts, then an emailed code on the server's own sign-in page, until Settings shows the account.
 * The caller routes the server's origin and the `chromiumapp.org` address first (`allowServer`).
 * The mailbox is emptied first, so the code read is this sign-in's.
 */
export async function signInFromSettings(
  context: BrowserContext,
  extensionId: string,
  serverUrl: string,
  email: string,
  /** Runs on the authorize page once the Email field is visible ('email') and once the code field is visible ('code'). */
  onStep?: (step: 'email' | 'code', page: Page) => Promise<void>,
): Promise<void> {
  const host = new URL(serverUrl).host;
  await clearMailbox();

  // The server card: address, then who receives posts.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html#/ai`);
  await options.getByText('UnAlgorithm server', { exact: true }).click();
  await options.getByLabel('Server address').fill(serverUrl);
  await options.getByRole('button', { name: 'Continue', exact: true }).click();
  const consent = options.getByText(/not HeitechSoft/);
  await expect(consent).toContainText(host);

  // Sign in on the server's own page with the emailed code.
  await options.getByRole('button', { name: 'Sign in and turn on' }).click();
  const signIn = await authorizePage(context, serverUrl);
  await expect(signIn.getByLabel('Email')).toBeVisible();
  await onStep?.('email', signIn);
  await signIn.getByLabel('Email').fill(email);
  await signIn.getByRole('button', { name: 'Send code' }).click();
  const code = signIn.getByLabel('6-digit code');
  await expect(code).toBeVisible();
  await onStep?.('code', signIn);
  await code.fill(await latestSignInCode());
  await signIn.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(options.getByText(`Signed in as ${email}`)).toBeVisible({ timeout: 15_000 });
}

/** The tab the extension opens on the server's sign-in page. */
async function authorizePage(context: BrowserContext, serverUrl: string): Promise<Page> {
  const find = () => context.pages().find((p) => p.url().startsWith(`${serverUrl}${AUTHORIZE_PAGE_PATH}`));
  await expect.poll(() => find() !== undefined, { timeout: 15_000 }).toBe(true);
  const page = find() as Page;
  await page.waitForLoadState();
  return page;
}

/**
 * Opens a confirm dialog with `opener` and checks it as a modal: the focus starts on "Cancel"; pressing Tab as many
 * times as the dialog has `controls`, plus one, never focuses anything behind it (past its last control a browser may
 * hand the focus to its own toolbar, which leaves the page with no focused element, and the next Tab comes back into
 * the dialog); the Escape key closes it.
 */
export async function expectDialogTrapsFocus(page: Page, opener: Locator, controls: number): Promise<void> {
  await opener.click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  /** Where the focus is: in the dialog, on nothing in the page, or on something behind the dialog. */
  const focus = () =>
    dialog.evaluate((d) => {
      const active = document.activeElement;
      if (active === null || active === document.body) return 'nothing';
      return d.contains(active) ? 'dialog' : 'behind';
    });
  for (let press = 0; press <= controls; press++) {
    await page.keyboard.press('Tab');
    expect(await focus()).not.toBe('behind');
  }
  expect(await focus()).toBe('dialog');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
}

/** No serious or critical axe violations, as `a11y.spec.ts` checks the extension's own pages. Soft, so a test goes on. */
export async function expectAccessible(page: Page): Promise<void> {
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
