import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { type MockOpenAI, startMockOpenAI } from '@unalgorithm/ai/testing';
import { expect, linkedinPost, saveSource, test } from './fixtures.ts';

/**
 * Chrome Web Store screenshots (docs/release.md): five 1280×800 PNGs in light mode, made from the fixture feed and the
 * mock AI server, never a real feed. The popup sits on a brand canvas; the side panel sits beside the feed, as Chrome
 * shows it. They are committed under docs/store/, so this runs only on request:
 * `pnpm --filter @unalgorithm/extension store:screens`.
 */
const OUT = resolve(import.meta.dirname, '../../../docs/store');
const W = 1280;
const H = 800;
const PANEL = 400;
/** The mark as scripts/make-icons.mjs renders it (96 px of art inside Chrome's 16 px padding). */
const MARK = readFileSync(resolve(import.meta.dirname, '../public/icon/128.png')).toString('base64');
const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI", system-ui, Roboto, Arial, sans-serif`;

/**
 * Card styling for the fixture page only: avatars as plain circles (the fixture's empty <svg>s are 300×150 by default),
 * names in bold, labelled counts, open comments folded. The extension's own UI is untouched.
 */
const TIDY_FEED = `
  a { color: inherit; text-decoration: none; }
  .e0shdr { margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid #ebebeb; color: #666; font-size: 13px; }
  .e0shdr a { color: #191919; font-weight: 600; }
  .e0sactor { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
  .e0sactor svg { display: block; width: 48px; height: 48px; border-radius: 50%; background: linear-gradient(135deg, #d5dde1, #aebcc3); }
  .e0sactor > div { flex: 1; }
  .e0sactor p { margin: 0; color: #666; font-size: 12px; line-height: 1.4; }
  .e0sactor > div > a, .e0sactor > div > a + p { display: inline-block; }
  .e0sactor a p { color: #191919; font-size: 14px; font-weight: 600; }
  .e0sactor button:empty, .e0sbar button:empty { display: none; }
  .e0sactor button { color: #404040; font-weight: 600; }
  [data-testid="expandable-text-box"] { margin: 4px 0 10px; font-size: 14px; }
  [data-testid="expandable-text-button"] { color: #666; }
  .e0sbar { display: flex; align-items: center; gap: 16px; padding: 2px 0 10px; color: #666; font-size: 13px; }
  .e0sbar a { margin-left: auto; font-weight: 600; }
  .e0sbar [aria-label^="Reaction"]::after { content: " reactions"; }
  .e0sbar [aria-label="Comment"]::after { content: " comments"; }
  .e0sbar [aria-label="Repost"]::after { content: " reposts"; }
  [data-component-type="LazyColumn"], .tiptap { display: none; }
`;

test.skip(process.env.UA_STORE !== '1', 'writes docs/store; run it with pnpm store:screens');

const png = (shot: Buffer) => `data:image/png;base64,${shot.toString('base64')}`;

/** Renders `body` at 1280×800 on `page` and saves it as `name`. */
async function compose(page: Page, name: string, body: string): Promise<void> {
  await page.setViewportSize({ width: W, height: H });
  await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; font-family: ${FONT}; color: #1d1d1f; }
  </style></head><body>${body}</body></html>`);
  await page.waitForFunction(() => [...document.images].every((img) => img.complete && img.naturalWidth > 0));
  await page.screenshot({ path: `${OUT}/${name}` });
}

/** A narrow surface on a Lagoon canvas: the lockup and a caption on the left, the surface on the right. */
function canvas(shot: Buffer, width: number, title: string, text: string): string {
  return `<div style="display:flex;align-items:center;gap:96px;height:100%;padding:0 112px;background:linear-gradient(160deg,#ecfaf8 0%,#d0f3ee 100%)">
    <div style="flex:1">
      <div style="display:flex;align-items:center;gap:14px">
        <img src="data:image/png;base64,${MARK}" width="48" height="48" style="margin:-8px" alt="">
        <span style="font-size:30px;font-weight:600;letter-spacing:-0.02em"><span style="color:#0b7a75;font-weight:700">Un</span>Algorithm</span>
      </div>
      <h1 style="margin:56px 0 0;font-size:44px;line-height:1.15;font-weight:700;letter-spacing:-0.02em">${title}</h1>
      <p style="margin:20px 0 0;font-size:21px;line-height:1.5;color:#5e5e63">${text}</p>
    </div>
    <img src="${png(shot)}" width="${width}" alt="" style="display:block;border-radius:14px;box-shadow:0 0 0 1px rgb(0 0 0 / .06),0 24px 56px rgb(5 69 66 / .22)">
  </div>`;
}

test('store screenshots', async ({ context, extensionId, feed }) => {
  mkdirSync(OUT, { recursive: true });
  const ai: MockOpenAI = await startMockOpenAI();
  try {
    await context.route('http://127.0.0.1:*/**', (route) => route.continue());
    const ext = (p: string) => `chrome-extension://${extensionId}/${p}`;

    // Onboarding with two interests, so the setup banner is gone and picks say what they matched.
    const onboarding = await context.newPage();
    await onboarding.goto(ext('onboarding.html'));
    await onboarding.getByRole('button', { name: 'Get started' }).click();
    await onboarding.getByRole('button', { name: 'Continue' }).click();
    await onboarding.getByRole('button', { name: 'AI & tech' }).click();
    await onboarding.getByRole('button', { name: 'Small business' }).click();
    await onboarding.getByRole('button', { name: 'Continue' }).click();
    await onboarding.getByRole('button', { name: 'Set up later' }).click();
    await expect(onboarding.getByRole('heading', { name: "You're all set." })).toBeVisible();
    await onboarding.close();
    // AI through the mock server, so the feed has "For you" picks and Highlights lists them.
    const config = { kind: 'openai-compatible', preset: 'custom', baseUrl: ai.baseUrl, auth: 'none', model: null };
    const options = await saveSource(context, extensionId, config, undefined, { test: true });

    // 1. The feed with noise folded away.
    const page = await feed('light');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: W, height: H });
    await page.addStyleTag({ content: TIDY_FEED });
    await expect(linkedinPost(page)).toHaveAttribute('data-unalgo-pick', '');
    // The first-fold tip is for first use; the listing shows the feed itself.
    await page.getByRole('button', { name: 'Got it' }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/screenshot-1-feed.png` });

    // 2. Why? on the folded ad.
    const promoted = page.locator('[componentkey="update-card-focusBBBkeyPromoted0002"]').locator('unalgo-post');
    await promoted.getByRole('button', { name: /Why was this hidden/ }).click();
    await expect(promoted.getByRole('dialog').getByText('Promoted post')).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/screenshot-2-why.png` });
    await page.keyboard.press('Escape');

    // 3. The popup, for the feed tab, without the line only development builds show.
    const popup = await context.newPage();
    await popup.emulateMedia({ colorScheme: 'light' });
    // Chrome sizes the popup to its content; fullPage does the same from a short viewport.
    await popup.setViewportSize({ width: 360, height: 200 });
    await popup.goto(ext('popup.html'));
    await page.bringToFront();
    const devLine = popup.getByRole('button', { name: 'Developer: copy diagnostics' });
    await devLine.evaluate((el) => el.remove());
    await popup.waitForTimeout(600);
    const popupShot = await popup.screenshot({ fullPage: true });
    const studio = await context.newPage();
    await compose(
      studio,
      'screenshot-3-popup.png',
      canvas(
        popupShot,
        360,
        'See what was folded away',
        'Counts for this page and today, by reason. Change Strength or pause a site in one click.',
      ),
    );

    // 4. Highlights in the side panel, beside the feed.
    await page.setViewportSize({ width: W - PANEL, height: H });
    const panel = await context.newPage();
    await panel.emulateMedia({ colorScheme: 'light' });
    await panel.setViewportSize({ width: PANEL, height: H });
    await panel.goto(ext('sidepanel.html'));
    await page.bringToFront();
    await expect(panel.getByText('LinkedIn · this page')).toBeVisible();
    await panel.waitForTimeout(800);
    const feedShot = await page.screenshot();
    const panelShot = await panel.screenshot();
    await compose(
      studio,
      'screenshot-4-highlights.png',
      `<div style="display:flex"><img src="${png(feedShot)}" width="${W - PANEL}" height="${H}" alt=""><img src="${png(panelShot)}" width="${PANEL}" height="${H}" alt=""></div>
      <div style="position:absolute;top:0;left:${W - PANEL}px;width:1px;height:${H}px;background:#d2d2d7"></div>`,
    );

    // 5. Settings: what to fold away on LinkedIn.
    await options.emulateMedia({ colorScheme: 'light' });
    await options.setViewportSize({ width: W, height: H });
    await options.goto(ext('options.html#/linkedin'));
    await options.waitForTimeout(600);
    await options.screenshot({ path: `${OUT}/screenshot-5-settings.png` });
  } finally {
    await ai.close();
  }
});
