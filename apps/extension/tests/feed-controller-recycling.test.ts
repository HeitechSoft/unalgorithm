/**
 * Health on a feed that empties and refills its slots, as Facebook's does (ADR 0009 §3, §9).
 *
 * Live on 2026-10-20: after Show all made the page tall, Facebook emptied the slots far from the viewport. Emptied slots
 * were left out of the health sample, so the hidden share went over Balanced's 90%, the page stopped hiding and every
 * folded post opened at once (2928 → 16699 px). At the next check too few items were left to judge, health was fine
 * again and everything folded: over and over, every 10 s, and the card never showed because no issue held for two
 * checks in a row. Now an emptied slot counts with its last decision, over-filtering holds until the page reloads or the
 * settings change, and its card shows at once. A panel the platform empties keeps counting as a panel too, so posts
 * misread as panels (`module-overmatch`) pause the page for good as well, without folding and opening.
 */
import { defaultDevice, defaultSettings, EMPTY_LEARNED, NO_SIGNALS, type PostData } from '@unalgorithm/core';
import { facebookAdapter, type InspectResult, type PlatformAdapter } from '@unalgorithm/platforms';
import type { PostKey } from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feed as homeFeed, panel, post, svgText } from '../../../packages/platforms/fixtures/facebook/live2026.ts';
import { type Bridge, type Entry, FeedController, type Runtime } from '../src/content/feed-controller.ts';

/** `s…` items are strangers' posts (folded at Balanced), `p…` items friends' (shown). */
const card = (key: string) => `<div data-item="${key}"><p>Card ${key}</p></div>`;
const feed = (keys: string[]) => `<div id="banner"></div><div role="feed" id="feed">${keys.map(card).join('')}</div>`;
const keys = (prefix: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => `${prefix}${from + i}`);

function inspect(el: HTMLElement): InspectResult {
  // An emptied slot (`data-virtualized`, or no text left in a slot that was a post).
  if (el.dataset.empty) return { kind: 'pending', offscreen: true };
  const key = el.dataset.item ?? '';
  const post: PostData = {
    id: `fb:${key}` as PostKey,
    platform: 'facebook',
    author: { name: `Author ${key}`, kind: 'person', relationship: key.startsWith('p') ? 'followed' : 'not-followed' },
    signals: { ...NO_SIGNALS },
    evidence: [{ signal: 'relationship', detector: 'fb.follow-button', strength: 'medium' }],
    text: `Post ${key}.`,
    textComplete: true,
    media: 'none',
    quality: { authorFound: true, textFound: true },
  };
  return { kind: 'post', post };
}

const adapter: PlatformAdapter = {
  id: 'facebook',
  version: 'facebook@2026.10.3',
  isFeedPage: () => true,
  feedScope: (doc) => doc.querySelector<HTMLElement>('#feed'),
  findItems: (scope) => Array.from(scope.querySelectorAll<HTMLElement>(':scope > [data-item]')),
  itemRootOf: (node, scope) => {
    const el = node instanceof Element ? node : node.parentElement;
    const root = el?.closest<HTMLElement>('[data-item]');
    return root && scope.contains(root) ? root : null;
  },
  inspect: (el) => inspect(el),
  signedIn: (doc) => !!doc.getElementById('banner'),
  probe: () => ({}),
  theme: () => 'light',
  markersFor: () => ({}),
};

/** The default settings (each hidden post on its own line), or with hidden posts in a row grouped (`group`). */
function runtime(group = false): Runtime {
  const settings = defaultSettings();
  settings.display.groupRuns = group;
  return {
    settings,
    device: defaultDevice('dev1'),
    learned: EMPTY_LEARNED,
    votes: {},
    serverOffer: null,
    officialList: { list: null, checkedAt: 0 },
  };
}

function bridge(): Bridge {
  return {
    classify: vi.fn(async () => ({ results: [] })),
    pushTabState: vi.fn(),
    vote: vi.fn(async () => undefined),
    settingsAction: vi.fn(async () => null),
    coachMarkShown: vi.fn(),
    openSettings: vi.fn(),
    report: vi.fn(),
    snoozeNotice: vi.fn(),
    factcheck: vi.fn(),
    openFactcheck: vi.fn(async () => true),
    perspectives: vi.fn(),
  };
}

const mountUi = (e: Entry) => {
  const host = document.createElement('unalgo-post');
  const container = document.createElement('div');
  host.attachShadow({ mode: 'open' }).append(container);
  e.el.appendChild(host);
  return { host, container };
};

const feedEl = () => document.getElementById('feed') as HTMLElement;
const el = (key: string) => document.querySelector<HTMLElement>(`[data-item="${key}"]`) as HTMLElement;
const folded = () => document.querySelectorAll('#feed [data-unalgo]').length;

/** How many times the platform emptied a slot (`empty`) and filled one in again (`fill`) during a test. */
const recycled = { emptied: 0, filled: 0 };

/** The platform empties a slot it no longer draws (Facebook keeps the slot, with a placeholder in it). */
function empty(key: string): void {
  const slot = el(key);
  slot.dataset.empty = 'true';
  slot.replaceChildren(document.createElement('div'));
  recycled.emptied++;
}

/** ...and fills it in again when it comes back near the viewport. */
function fill(key: string): void {
  const slot = el(key);
  delete slot.dataset.empty;
  const p = document.createElement('p');
  p.textContent = `Card ${key}`;
  slot.replaceChildren(p);
  recycled.filled++;
}

/**
 * Facebook's answer to the page's height: with every post open the page is many screens taller, and the slots in
 * `far` are past its distance limit, so it empties them; once posts fold again they are near enough to be filled in.
 */
function recycle(far: string[]): MutationObserver {
  const platform = new MutationObserver(() => {
    const open = folded() === 0;
    for (const key of far) {
      const emptied = !!el(key).dataset.empty;
      if (open && !emptied) empty(key);
      if (!open && emptied) fill(key);
    }
  });
  platform.observe(feedEl(), { subtree: true, attributes: true, attributeFilter: ['data-unalgo'] });
  return platform;
}

/** Every change to our fold attributes on the feed's items (in `list`) while `during` runs. */
async function flipsDuring(during: () => Promise<unknown>, list: HTMLElement = feedEl()): Promise<number> {
  let flips = 0;
  const watch = new MutationObserver((records) => {
    flips += records.length;
  });
  watch.observe(list, { subtree: true, attributes: true, attributeFilter: ['data-unalgo', 'data-unalgo-run'] });
  await during();
  flips += watch.takeRecords().length;
  watch.disconnect();
  return flips;
}

/** Every item on screen (jsdom has no IntersectionObserver), so the coach mark finds a folded line to point at. */
class OnScreenIO {
  root = null;
  constructor(private cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() => this.cb([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], this as never));
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

/** Health checks run every 10 s: advance through `n` of them. */
const checks = (n: number) => vi.advanceTimersByTimeAsync(n * 10_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  document.documentElement.lang = 'en';
  recycled.emptied = 0;
  recycled.filled = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('emptied slots in the health sample', () => {
  // Grouped, as live on 2026-10-20, after Show all on the run; and as by default, each hidden post on its own line.
  it.each([
    ['grouped, after Show all', true],
    ['one line each, the default', false],
  ])('test_emptied_shown_posts_do_not_tip_the_page_into_over_filtering (%s)', async (_, group) => {
    // Four friends' posts, then 26 strangers' posts: Balanced folds 26 of 30 (87%), under its 90%.
    const P = keys('p', 4);
    const S = keys('s', 26);
    document.body.innerHTML = feed([...P, ...S]);
    const c = new FeedController(adapter, bridge(), mountUi);
    c.start(runtime(group));
    await checks(1);
    expect(c.getHealth()).toMatchObject({ status: 'ok', issues: [] });
    expect(folded()).toBe(26);
    // One fold line each (Show all on the strangers' run, when grouped): the page grows, and Facebook empties the
    // friends' posts far above. Opening everything would grow it again and empty most of the strangers' posts too.
    const lead = c.mounted().find((e) => e.id === 'fb:s0');
    expect(lead?.run).toStrictEqual(group ? { count: 26, labels: expect.any(Array) } : undefined);
    if (group) lead?.handlers?.onShowAll();
    expect(document.querySelectorAll('[data-unalgo-run]')).toHaveLength(0);
    for (const key of P) empty(key);
    const platform = recycle(S.slice(0, 20));
    await vi.advanceTimersByTimeAsync(500);
    // Check after check, the page stays as it is: nothing opens, nothing folds again.
    const flips = await flipsDuring(() => checks(30));
    platform.disconnect();
    expect(flips).toBe(0);
    expect(c.getHealth()).toMatchObject({ status: 'ok', issues: [] });
    expect(folded()).toBe(26);
    expect(c.notice()).toBeNull();
    c.stop();
  });
});

describe('panels emptied far away', () => {
  /** A panel like People you may know, suggesting a different person each time. */
  const suggestion = (i: number) =>
    panel(
      'People you may know',
      'h3',
      `<div aria-label="People you may know" role="region"><div role="grid"><div role="row"><div role="cell"><a href="https://www.facebook.com/person.${i}" role="link"><span>Person ${i}</span></a><div role="button" tabindex="0"><span>Add friend</span></div></div></div></div></div>`,
    );
  /** A friend's post: shown at Balanced. */
  const friend = (i: number) =>
    post({ author: `Friend ${'ABCD'[i]}`, slot: svgText('SvgT1'), text: `Supper with the family, part ${i}.`, menu: true });

  // Posts misread as panels: 6 panels among 10 items is over the 50% that pauses filtering (module-overmatch). The real
  // Facebook adapter reads the slots, so an emptied panel reads exactly as it does on the live site.
  it('test_module_overmatch_does_not_fold_and_open_while_far_off_panels_empty_and_refill', async () => {
    document.body.innerHTML = homeFeed(
      suggestion(0),
      suggestion(1),
      friend(0),
      suggestion(2),
      friend(1),
      suggestion(3),
      friend(2),
      suggestion(4),
      friend(3),
      suggestion(5),
    );
    const scope = facebookAdapter.feedScope(document) as HTMLElement;
    const slots = facebookAdapter.findItems(scope);
    const list = slots[0]?.parentElement as HTMLElement;
    // The two panels at the top, far above the screen once the page is many screens taller.
    const far = slots.slice(0, 2);
    const original = new Map(far.map((slot) => [slot, slot.innerHTML]));
    const foldedHere = () => list.querySelectorAll('[data-unalgo]').length;
    const emptied = (slot: HTMLElement) => slot.childElementCount === 0;
    let refilled = 0;
    const emptySlot = (slot: HTMLElement) => slot.replaceChildren();
    const fillSlot = (slot: HTMLElement) => {
      slot.innerHTML = original.get(slot) ?? '';
      refilled++;
    };
    // Facebook's answer to the page's height: with everything open the far panels empty; once posts fold, they're near
    // enough to be filled in again.
    const platform = new MutationObserver(() => {
      const open = foldedHere() === 0;
      for (const slot of far) {
        if (open && !emptied(slot)) emptySlot(slot);
        if (!open && emptied(slot)) fillSlot(slot);
      }
    });
    platform.observe(list, { subtree: true, attributes: true, attributeFilter: ['data-unalgo'] });

    const c = new FeedController(facebookAdapter, bridge(), mountUi);
    c.start(runtime());
    await vi.advanceTimersByTimeAsync(0);
    expect(foldedHere()).toBe(6);
    await checks(1);
    // Too many panels: filtering stops, everything opens, and the far panels empty. The card waits for a second check.
    expect(c.getHealth()).toMatchObject({ status: 'broken' });
    expect(c.getHealth().issues).toContain('module-overmatch');
    expect(foldedHere()).toBe(0);
    expect(far.every(emptied)).toBe(true);
    expect(c.notice()).toBeNull();
    // The emptied panels still count as panels, so the second check agrees, and the card shows.
    const flips = await flipsDuring(async () => {
      await checks(1);
      expect(c.notice()?.kind).toBe('paused');
      // Check after check, and as the person scrolls back up to the top and down again, nothing folds or opens.
      await checks(10);
      for (const slot of far) fillSlot(slot);
      await checks(5);
      for (const slot of far) emptySlot(slot);
      await checks(15);
    }, list);
    platform.disconnect();
    expect(refilled).toBe(2);
    expect(flips).toBe(0);
    expect(foldedHere()).toBe(0);
    expect(c.getHealth().issues).toContain('module-overmatch');
    expect(c.notice()?.kind).toBe('paused');
    c.stop();
  });
});

describe('over-filtering holds for the page load', () => {
  /** One friend's post and 29 strangers': 29 of 30 (97%) is over Balanced's 90%. */
  const S = keys('s', 29);
  const nearlyAll = () => feed(['p0', ...S]);

  it('test_over_filtering_stays_paused_while_the_feed_recycles_and_grows', async () => {
    document.body.innerHTML = nearlyAll();
    const c = new FeedController(adapter, bridge(), mountUi);
    c.start(runtime());
    await vi.advanceTimersByTimeAsync(0);
    expect(folded()).toBe(29);
    // Facebook's answer to the page's height, from the start: once every post is open, the far-off slots empty.
    const far = S.slice(0, 20);
    const platform = recycle(far);
    await checks(1);
    // The first check stops hiding (fail open), and the card says so at once.
    expect(c.getHealth()).toMatchObject({ status: 'broken', issues: ['over-filtering'], notice: 'paused' });
    expect(folded()).toBe(0);
    expect(c.notice()).toStrictEqual({ kind: 'paused', platform: 'facebook', issues: ['over-filtering'] });
    expect(recycled.emptied).toBe(20);
    // As the person scrolls on, friends' posts load: ten of them bring the window's share down to 67%. On the way they
    // scroll back up a little, and Facebook fills two far-off posts in again, then empties them once more. The page
    // stays paused, check after check.
    const flips = await flipsDuring(async () => {
      for (let i = 0; i < 10; i++) {
        feedEl().insertAdjacentHTML('beforeend', card(`p${i + 1}`));
        const back = far.slice(2 * i, 2 * i + 2);
        for (const key of back) fill(key);
        await checks(1);
        for (const key of back) empty(key);
        await checks(2);
      }
    });
    platform.disconnect();
    expect(recycled).toStrictEqual({ emptied: 40, filled: 20 });
    expect(flips).toBe(0);
    expect(folded()).toBe(0);
    expect(c.getHealth()).toMatchObject({ status: 'broken', issues: ['over-filtering'] });
    // The card showed once and is still up: nothing came and went.
    expect(c.notice()?.kind).toBe('paused');
    expect(c.buildState().notice).toStrictEqual({ kind: 'paused', issues: ['over-filtering'] });
    c.stop();
  });

  it('test_the_card_is_not_held_back_by_a_coach_mark_that_went_with_the_folds', async () => {
    vi.stubGlobal('IntersectionObserver', OnScreenIO);
    document.body.innerHTML = nearlyAll();
    const c = new FeedController(adapter, bridge(), mountUi);
    c.start(runtime());
    await vi.advanceTimersByTimeAsync(0);
    // A first visit: the coach mark points at the first folded line on screen.
    expect(c.mounted().some((e) => e.coach)).toBe(true);
    await checks(1);
    // The page stopped hiding, so no folded line is left to hold a coach mark: the card shows at once.
    expect(folded()).toBe(0);
    expect(c.notice()?.kind).toBe('paused');
    c.stop();
  });

  it('test_held_pause_outlasts_leaving_the_feed_and_coming_back', async () => {
    document.body.innerHTML = nearlyAll();
    const rt = runtime();
    const c = new FeedController(adapter, bridge(), mountUi);
    c.start(rt);
    await checks(1);
    expect(c.getHealth().status).toBe('broken');
    // A visit to a group and back, in the same page load: a fine-looking feed now, and still paused.
    c.stop();
    document.body.innerHTML = feed([...keys('p', 15), ...keys('s', 15)]);
    c.start(rt);
    await vi.advanceTimersByTimeAsync(0);
    expect(folded()).toBe(0);
    await checks(3);
    expect(c.getHealth()).toMatchObject({ status: 'broken', issues: ['over-filtering'] });
    expect(folded()).toBe(0);
    c.stop();
    // A reload is a new page load: judged afresh.
    const reloaded = new FeedController(adapter, bridge(), mountUi);
    reloaded.start(rt);
    await checks(1);
    expect(reloaded.getHealth()).toMatchObject({ status: 'ok', issues: [] });
    expect(folded()).toBe(15);
    reloaded.stop();
  });

  it('test_a_settings_change_ends_the_hold_at_once', async () => {
    document.body.innerHTML = nearlyAll();
    const rt = runtime();
    const c = new FeedController(adapter, bridge(), mountUi);
    c.start(rt);
    await checks(1);
    expect(c.notice()?.kind).toBe('paused');
    // A change that hides nothing more or less still ends the hold: judged again at once, still over, still paused.
    const reels = structuredClone(rt.settings);
    reels.platforms.facebook.filters.reels = true;
    c.update({ ...rt, settings: reels });
    expect(c.getHealth()).toMatchObject({ status: 'broken', issues: ['over-filtering'] });
    expect(c.notice()?.kind).toBe('paused');
    expect(folded()).toBe(0);
    // The person stops hiding strangers: judged again at once, without waiting for the next check. The card goes.
    const relaxed = structuredClone(reels);
    relaxed.platforms.facebook.filters.notFollowed = false;
    c.update({ ...rt, settings: relaxed });
    expect(c.getHealth()).toMatchObject({ status: 'ok', issues: [] });
    expect(c.notice()).toBeNull();
    await checks(3);
    expect(c.getHealth()).toMatchObject({ status: 'ok', issues: [] });
    // On again: it folds, the next check finds it over the limit, and the page is paused for good; the card had its
    // one showing on this page load, and the popup still says it.
    c.update({ ...rt, settings: reels });
    expect(folded()).toBe(29);
    await checks(1);
    expect(c.getHealth()).toMatchObject({ status: 'broken', issues: ['over-filtering'] });
    expect(folded()).toBe(0);
    expect(c.notice()).toBeNull();
    expect(c.buildState().notice?.kind).toBe('paused');
    const flips = await flipsDuring(() => checks(10));
    expect(flips).toBe(0);
    c.stop();
  });

  it('test_other_causes_still_wait_for_two_checks', async () => {
    // Text that can't be read on most posts pauses filtering too, but its card waits for a second check in a row.
    const noText: PlatformAdapter = {
      ...adapter,
      inspect: (node) => {
        const r = inspect(node);
        return r.kind === 'post' ? { ...r, post: { ...r.post, quality: { ...r.post.quality, textFound: false } } } : r;
      },
    };
    document.body.innerHTML = feed(keys('p', 12));
    const c = new FeedController(noText, bridge(), mountUi);
    c.start(runtime());
    await checks(1);
    expect(c.getHealth()).toMatchObject({ status: 'broken', issues: ['text-detection'] });
    expect(c.notice()).toBeNull();
    await checks(1);
    expect(c.notice()?.kind).toBe('paused');
    c.stop();
  });
});
