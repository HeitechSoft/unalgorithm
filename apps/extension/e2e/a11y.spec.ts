import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.ts';

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

for (const scheme of ['light', 'dark'] as const) {
  test(`extension pages have no serious accessibility issues (${scheme})`, async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    const problems: string[] = [];
    for (const p of PAGES) {
      await page.goto(`chrome-extension://${extensionId}/${p}`);
      await page.waitForTimeout(300);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      for (const v of results.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
        problems.push(
          `${p}: ${v.id} (${v.impact}) ${v.nodes
            .slice(0, 3)
            .map((n) => n.target.join(' '))
            .join(' | ')}`,
        );
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
}
