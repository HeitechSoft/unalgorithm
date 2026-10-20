import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from './fixtures.ts';

/** Screenshot matrix for design review: every surface, light and dark. Output goes to /screens (gitignored). */
const OUT = resolve(import.meta.dirname, '../../../screens');
mkdirSync(OUT, { recursive: true });

for (const scheme of ['light', 'dark'] as const) {
  test(`screens (${scheme})`, async ({ context, extensionId, feed }) => {
    const ext = (p: string) => `chrome-extension://${extensionId}/${p}`;
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: scheme });

    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto(ext('onboarding.html'));
    await page.waitForTimeout(5200); // let the welcome illustration finish
    await page.screenshot({ path: `${OUT}/onboarding-1-welcome-${scheme}.png` });
    await page.getByRole('button', { name: 'Get started' }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/onboarding-2-strength-${scheme}.png` });
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'More: AI & tech' }).click();
    await page.getByRole('button', { name: 'More: Small business' }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/onboarding-3-interests-${scheme}.png` });
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/onboarding-4-ai-${scheme}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Set up later' }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/onboarding-5-done-${scheme}.png` });

    for (const pane of ['linkedin', 'display', 'interests', 'ai', 'privacy', 'about']) {
      await page.goto(ext(`options.html#/${pane}`));
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/settings-${pane}-${scheme}.png`, fullPage: true });
    }

    const feedPage = await feed(scheme);
    await feedPage.emulateMedia({ colorScheme: scheme });
    await feedPage.waitForTimeout(1500);
    await feedPage.screenshot({ path: `${OUT}/feed-linkedin-${scheme}.png`, fullPage: true });

    await page.setViewportSize({ width: 360, height: 620 });
    await page.goto(ext('popup.html'));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/popup-${scheme}.png`, fullPage: true });

    await page.setViewportSize({ width: 400, height: 760 });
    await page.goto(ext('sidepanel.html'));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/sidepanel-${scheme}.png`, fullPage: true });
  });
}
