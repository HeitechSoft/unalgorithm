import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Page } from '@playwright/test';
import { REPORTS_PATH } from '@unalgorithm/protocol';
import { expect, settled, test } from './fixtures.ts';
import { E2E_REPORTS_PORT } from './server-harness.ts';

const PAGES = [
  'onboarding.html',
  'options.html#/linkedin',
  'options.html#/facebook',
  'options.html#/display',
  'options.html#/interests',
  'options.html#/ai',
  'options.html#/privacy',
  'options.html#/about',
  'popup.html',
  'sidepanel.html',
];

/** Serious and critical axe violations on `page` (WCAG 2.2 AA tags), each prefixed with `where`. */
async function axeProblems(page: Page, where: string): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  return results.violations
    .filter((x) => x.impact === 'serious' || x.impact === 'critical')
    .map(
      (v) =>
        `${where}: ${v.id} (${v.impact}) ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join(' | ')}`,
    );
}

for (const scheme of ['light', 'dark'] as const) {
  test(`extension pages have no serious accessibility issues (${scheme})`, async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const problems: string[] = [];
    for (const p of PAGES) {
      await page.goto(`chrome-extension://${extensionId}/${p}`);
      await page.waitForTimeout(300);
      problems.push(...(await axeProblems(page, p)));
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  /** The topic list with topics marked More and Less, in onboarding's interests step and in Settings → Interests. */
  test(`the topic list has no serious accessibility issues (${scheme})`, async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.goto(`chrome-extension://${extensionId}/onboarding.html`);
    await page.getByRole('button', { name: 'Get started' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'More: AI & tech' }).click();
    await page.getByRole('button', { name: 'Less: Startups' }).click();
    await page.getByRole('button', { name: 'Show all topics' }).click();
    await page.getByRole('button', { name: 'More: Politics' }).click();
    await expect(page.getByText('3 selected')).toBeVisible();
    // A pressed button's colours fade in (`.ua-button`); checked once they have.
    await settled(page.locator('body'));
    const problems = await axeProblems(page, 'onboarding.html (interests)');
    await page.goto(`chrome-extension://${extensionId}/options.html#/interests`);
    await expect(page.getByRole('button', { name: 'More: Politics' })).toHaveAttribute('aria-pressed', 'true');
    problems.push(...(await axeProblems(page, 'options.html#/interests (marked)')));
    expect(problems, problems.join('\n')).toEqual([]);
  });

  /**
   * The report page (ADR 0009 §2) has no address of its own: a draft is kept for it first. Checked as it opens (with
   * the exact body shown), with a missing answer, and sent (the e2e builds' report address answered here); then a
   * correction's form.
   */
  test(`the report page has no serious accessibility issues (${scheme})`, async ({ context, extensionId }) => {
    await context.route(`http://127.0.0.1:${E2E_REPORTS_PORT}${REPORTS_PATH}`, (route) =>
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, ref: '7KQ3-M2PA' }) }),
    );
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html#/about`);
    const problems: string[] = [];

    const detection = await openReport(context, options, { about: { from: 'popup', platform: 'linkedin', tabId: null } }, scheme);
    await detection.getByText("Show exactly what's sent").click();
    problems.push(...(await axeProblems(detection, 'report.html (detection)')));
    await detection.getByRole('button', { name: 'Send report' }).click();
    await expect(detection.getByText('Choose at least one')).toBeVisible();
    problems.push(...(await axeProblems(detection, 'report.html (missing answer)')));
    await detection.getByRole('checkbox', { name: 'Ads are still showing' }).check();
    await detection.getByRole('button', { name: 'Send report' }).click();
    await expect(detection.getByRole('heading', { name: 'Thanks, we got it.' })).toBeVisible();
    problems.push(...(await axeProblems(detection, 'report.html (sent)')));

    const correction = await openReport(
      context,
      options,
      {
        draft: { kind: 'correction', from: 'sidepanel', correction: { feature: 'factcheck', promptVersion: 3, via: 'own-key' } },
      },
      scheme,
    );
    await correction.getByRole('button', { name: 'Send report' }).click();
    await expect(correction.getByText('Choose one')).toBeVisible();
    problems.push(...(await axeProblems(correction, 'report.html (correction)')));
    expect(problems, problems.join('\n')).toEqual([]);
  });
}

/**
 * Onboarding's bottom bar (Back, N selected, Continue) stays at the bottom of the window and covers what scrolls under
 * it. Tabbing through the whole topic list, each control that takes focus is scrolled clear of it (WCAG 2.4.11), at a
 * window short enough that the first ten topics already run under the bar.
 */
test('focus in the topic list is never under the onboarding bar', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`chrome-extension://${extensionId}/onboarding.html`);
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  const heading = page.getByRole('heading', { level: 1, name: 'What do you want more or less of?' });
  /** Tabs from the heading to the bar, noting each control that is focused while the bar covers it. */
  const tabToBar = async () => {
    const problems: string[] = [];
    await heading.focus();
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('Tab');
      const at = await page.evaluate(() => {
        const el = document.activeElement;
        const bar = document.querySelector('.ob-bar');
        if (!el || !bar || bar.contains(el)) return null;
        const r = el.getBoundingClientRect();
        return {
          name: el.getAttribute('aria-label') || (el as HTMLInputElement).labels?.[0]?.textContent || el.textContent?.trim(),
          bottom: r.bottom,
          bar: bar.getBoundingClientRect().top,
        };
      });
      if (!at) return problems;
      if (at.bottom > at.bar + 0.5) problems.push(`${at.name}: ends at ${at.bottom}, the bar starts at ${at.bar}`);
    }
    throw new Error('Tab never reached the bar');
  };
  // The first ten topics, Show all topics and the add field; then every topic.
  const problems = await tabToBar();
  await page.getByRole('button', { name: 'Show all topics' }).click();
  await expect(page.getByRole('button', { name: 'Show fewer topics' })).toBeVisible();
  problems.push(...(await tabToBar()));
  expect(problems, problems.join('\n')).toEqual([]);
});

/** Keeps a draft from an extension page, as the popup, Settings and the side panel do, and returns its report page. */
async function openReport(context: BrowserContext, from: Page, message: object, scheme: 'light' | 'dark'): Promise<Page> {
  const opened = context.waitForEvent('page', { predicate: (p) => new URL(p.url()).pathname === '/report.html' });
  expect(await from.evaluate((m) => chrome.runtime.sendMessage({ type: 'openReport', ...m }), message)).toEqual({ ok: true });
  const report = await opened;
  await report.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await expect(report.getByRole('button', { name: 'Send report' })).toBeVisible();
  return report;
}
