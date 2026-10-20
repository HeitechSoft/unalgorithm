import type { Page } from 'puppeteer-core';
import { aria, axeProblems, click, extensionPage, launchFirefox, navigate, sleep, visible } from './driver.ts';
import { expect, test } from './fixtures.ts';

/** The extension's own pages, as `../a11y.spec.ts` checks them in Chromium and Edge; the report page after them. */
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

/** Firefox's colour scheme for web content (`prefers-color-scheme`); BiDi has no media emulation. */
const SCHEMES = { dark: 0, light: 1 } as const;

for (const scheme of ['light', 'dark'] as const) {
  test(`test_firefox_extension_pages_accessible (${scheme})`, async () => {
    const firefox = await launchFirefox({
      prefs: { 'layout.css.prefers-color-scheme.content-override': SCHEMES[scheme], 'ui.prefersReducedMotion': 1 },
    });
    try {
      const page = await firefox.open('onboarding.html');
      expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(scheme === 'dark');
      const problems: string[] = [];
      for (const path of PAGES) {
        // A new document each time: the options panes are one page, and a hash change alone keeps its state.
        await navigate(page, 'about:blank');
        await navigate(page, `${firefox.base}/${path}`);
        await sleep(300);
        for (const problem of await axeProblems(page)) problems.push(`${path}: ${problem}`);
      }
      // The topic list with topics marked More and Less, as `../a11y.spec.ts` checks it.
      await navigate(page, 'about:blank');
      await navigate(page, `${firefox.base}/options.html#/interests`);
      await click(page, aria('button', 'More: Politics'));
      await click(page, aria('button', 'Less: Startups'));
      await page.waitForFunction(() =>
        ['More: Politics', 'Less: Startups'].every(
          (name) => document.querySelector(`[aria-label="${name}"]`)?.getAttribute('aria-pressed') === 'true',
        ),
      );
      // A pressed button's colours fade in (`.ua-button`); checked once they have.
      await page.evaluate(async () => void (await Promise.allSettled(document.getAnimations().map((a) => a.finished))));
      for (const problem of await axeProblems(page)) problems.push(`options.html#/interests (marked): ${problem}`);
      // The report page has no address of its own: Settings → About → Report a problem keeps a draft and opens it. A
      // temporary add-on starts without technical data, so it shows Firefox's own way out (Email this report).
      await navigate(page, `${firefox.base}/options.html#/about`);
      await click(page, aria('button', 'Report a problem'));
      const report = await extensionPage(firefox.browser, '/report.html');
      await visible(report, aria('radio', 'LinkedIn'));
      await click(report, aria('radio', 'LinkedIn'));
      await visible(report, aria('link', 'Email this report'));
      for (const problem of await axeProblems(report)) problems.push(`report.html: ${problem}`);
      expect(problems, problems.join('\n')).toEqual([]);
    } finally {
      await firefox.close();
    }
  });
}

/**
 * As `../a11y.spec.ts` checks it in Chromium: onboarding's bottom bar covers what scrolls under it, so tabbing through
 * the topic list, short and then whole, each control that takes focus is scrolled clear of the bar (WCAG 2.4.11).
 */
test('test_firefox_topic_list_focus_clear_of_the_bar', async () => {
  const firefox = await launchFirefox({ prefs: { 'ui.prefersReducedMotion': 1 } });
  try {
    // A window short enough that the first ten topics already run under the bar. Firefox's automation can't size a tab
    // that shows an extension page, so the size is set on a new tab before it opens onboarding.
    const page = await firefox.browser.newPage();
    await page.setViewport({ width: 1280, height: 700 });
    await navigate(page, `${firefox.base}/onboarding.html`);
    expect(await page.evaluate(() => innerHeight)).toBe(700);
    await click(page, aria('button', 'Get started'));
    await click(page, aria('button', 'Continue'));
    await visible(page, aria('button', 'Show all topics'));
    const problems = await focusUnderBar(page);
    await click(page, aria('button', 'Show all topics'));
    await visible(page, aria('button', 'Show fewer topics'));
    problems.push(...(await focusUnderBar(page)));
    expect(problems, problems.join('\n')).toEqual([]);
  } finally {
    await firefox.close();
  }
});

/** Tabs from the step's heading to the bottom bar, noting each control that is focused while the bar covers it. */
async function focusUnderBar(page: Page): Promise<string[]> {
  const problems: string[] = [];
  await page.evaluate(() => document.querySelector<HTMLElement>('main h1')?.focus());
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
}
