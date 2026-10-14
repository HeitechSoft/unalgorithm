import type { BrowserContext, Page } from '@playwright/test';
import { AUTHORIZE_PAGE_PATH } from '@unalgorithm/protocol';
import { expect } from './fixtures.ts';
import { clearMailbox, latestSignInCode } from './server-harness.ts';

/**
 * Signs the extension in to a local server from Settings → AI, as a person does (CL1-20): the server card and its
 * address, who receives posts, then an emailed code on the server's own sign-in page, until Settings shows the account.
 * The caller routes the server's origin and the `chromiumapp.org` address the sign-in page sends the browser back to.
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
