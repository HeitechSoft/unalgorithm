import { axeProblems, launchFirefox, navigate, sleep } from './driver.ts';
import { expect, test } from './fixtures.ts';

/** The extension's own pages, as `../a11y.spec.ts` checks them in Chromium and Edge. */
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
      expect(problems, problems.join('\n')).toEqual([]);
    } finally {
      await firefox.close();
    }
  });
}
