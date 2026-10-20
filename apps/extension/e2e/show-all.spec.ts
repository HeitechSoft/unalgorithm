import { feed, post, svgText } from '../../../packages/platforms/fixtures/facebook/live2026.ts';
import { expect, test } from './fixtures.ts';

/**
 * Facebook empties a feed slot once it has scrolled far above the viewport, leaving a placeholder as tall as the post
 * was, and fills it in again when it comes back near. This stands in for it on the fixture page: every 50 ms and on
 * every scroll, slots whose bottom is more than 500 px above the viewport are emptied, and refilled once they are not.
 * Slots with no box (folded into a run) are left alone, as Facebook leaves them.
 */
const VIRTUALIZER = `(() => {
  const FAR = 500;
  const kept = new WeakMap();
  const heights = new WeakMap();
  window.__emptied = 0;
  const tick = () => {
    const list = document.querySelector('[role="main"] h3 ~ div:last-child');
    for (const slot of list ? list.children : []) {
      const box = slot.querySelector('[data-virtualized]');
      if (!box) continue;
      if (box.dataset.virtualized === 'false' && box.offsetHeight > 0) heights.set(box, box.offsetHeight);
      const r = slot.getBoundingClientRect();
      if (r.height === 0) continue;
      const far = r.bottom < -FAR;
      if (far && box.dataset.virtualized === 'false') {
        kept.set(box, [...box.childNodes]);
        const hole = document.createElement('div');
        hole.hidden = true;
        box.replaceChildren(hole);
        box.dataset.virtualized = 'true';
        box.style.minHeight = (heights.get(box) || 0) + 'px';
        window.__emptied++;
      } else if (!far && box.dataset.virtualized === 'true') {
        box.replaceChildren(...(kept.get(box) || []));
        box.dataset.virtualized = 'false';
        box.style.removeProperty('min-height');
      }
    }
  };
  setInterval(tick, 50);
  addEventListener('scroll', tick, { passive: true });
})();`;

/** People and pages the account doesn't follow (folded at Balanced), and friends' posts (shown). */
const stranger = (run: string, i: number) =>
  post({ author: `Page ${run}${i}`, slot: svgText('SvgT1'), text: `Offer number ${i} from page ${run}.`, follow: true }).replace(
    '<div>',
    `<div data-run="${run}">`,
  );
const friend = (i: number) => post({ author: `Friend ${i}`, slot: svgText('SvgT1'), text: `What friend ${i} did this weekend.` });

/**
 * Four strangers, a friend, thirty strangers, six friends: two runs, the second long enough to scroll through. The
 * friends at the end keep the page healthy. The health check looks at the last 30 items: with one friend at the end,
 * 29 of them would be hidden, more than Balanced's 90%, and the controller's first check (10 s in) would stop hiding
 * on the page and unfold everything. With six, 24 are hidden.
 */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Facebook</title><style>
  body { margin: 0; font: 14px sans-serif; background: #f0f2f5; }
  [role="main"] { max-width: 560px; margin: 0 auto; }
  [aria-posinset] { min-height: 360px; margin: 8px 0; background: #fff; }
</style></head><body>${feed(
  ...Array.from({ length: 4 }, (_, i) => stranger('s', i)),
  friend(1),
  ...Array.from({ length: 30 }, (_, i) => stranger('t', i)),
  ...Array.from({ length: 6 }, (_, i) => friend(2 + i)),
)}<script>${VIRTUALIZER}</script></body></html>`;

test('Facebook: Show all keeps a long run open while the feed empties and refills slots far away', async ({ context }) => {
  await context.route('https://www.facebook.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }),
  );
  const page = await context.newPage();
  await page.goto('https://www.facebook.com/');
  // Each wheel step waits for a frame, and headless Chromium draws one only when the page changes and is in front:
  // about a second per step otherwise. In front and asking for every frame, the steps are as quick as a person's.
  await page.bringToFront();
  await page.evaluate(() => {
    const frame = () => requestAnimationFrame(frame);
    frame();
  });
  const runs = page.locator('[data-run="t"]');
  const folded = page.locator('[data-run="t"][data-unalgo="collapsed"]:not([data-unalgo-run])');
  await expect(runs).toHaveCount(30);
  await page.getByRole('button', { name: 'Show all 30 hidden posts' }).click();
  await expect(folded).toHaveCount(30);

  // From here on, count every change to the opened run's run marks, and the scroll position after each wheel step.
  await page.evaluate(() => {
    const w = window as unknown as { __flips: number };
    w.__flips = 0;
    new MutationObserver((records) => {
      w.__flips += records.filter((r) => (r.target as Element).getAttribute('data-run') === 't').length;
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-unalgo-run'] });
  });
  const flips = () => page.evaluate(() => (window as unknown as { __flips: number }).__flips);
  const scrollY = () => page.evaluate(() => Math.round(window.scrollY));

  // Sit still with the opened run in view until past the controller's first health check (10 s after it starts). The
  // run stays open and the page stays put. Had the page failed open there, all thirty would unfold, and the checks
  // after this one would test a page that hides nothing.
  await page.waitForTimeout(1000);
  const idleY = await scrollY();
  await page.waitForFunction(() => performance.now() > 12_000, undefined, { timeout: 20_000 });
  await expect(folded).toHaveCount(30);
  expect(await flips()).toBe(0);
  expect(await scrollY()).toBe(idleY);

  // Scroll down through the thirty fold lines and on to the end of the feed, a wheel step at a time.
  await page.mouse.move(640, 430);
  const ys: number[] = [await scrollY()];
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(80);
    ys.push(await scrollY());
  }
  // The friend's post between the runs, and the first of the thirty, were emptied on the way down.
  expect(await page.evaluate(() => (window as unknown as { __emptied: number }).__emptied)).toBeGreaterThan(1);
  // Only ever down: the page never jumped back up under the wheel.
  const back = ys.slice(1).filter((y, i) => y < (ys[i] as number) - 2);
  expect(back, `scroll positions: ${ys.join(' ')}`).toEqual([]);
  // The opened run never folded again, not even for a moment.
  expect(await flips()).toBe(0);
  await expect(page.locator('[data-run="t"][data-unalgo-run]')).toHaveCount(0);

  // Back up to the opened run: its slots are filled in again, and each post folds on its own line again, out of any run.
  await runs.first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect(page.locator('[data-run="t"] [data-virtualized="true"]')).toHaveCount(0);
  await expect(folded).toHaveCount(30);
  expect(await flips()).toBe(0);

  // Settled: nothing changes while the page sits still.
  await page.waitForTimeout(1000);
  const [settledFlips, settledY] = [await flips(), await scrollY()];
  await page.waitForTimeout(2000);
  expect(await flips()).toBe(settledFlips);
  expect(await scrollY()).toBe(settledY);
});
