import type { TabState } from '@unalgorithm/core';
import { browser } from 'wxt/browser';
import { statsItem, tabStateItem } from '../lib/storage.ts';
import { forgetFactchecks } from './factcheck.ts';
import { createLock, dateKey, readSettingsSafe } from './util.ts';

const lock = createLock();
/** Post keys already counted in today's stats during this browser session. */
const counted = new Map<string, Set<string>>();

/** Merge a content script's live state into session storage, then update the toolbar badge. */
export async function mergeTabState(tabId: number, patch: Partial<TabState>): Promise<void> {
  await lock(async () => {
    const item = tabStateItem(tabId);
    const next = { ...(await item.getValue()), ...patch, updatedAt: Date.now() } as TabState;
    await item.setValue(next);
    await updateBadge(tabId, next);
    await countToday(next);
  });
}

async function countToday(s: TabState): Promise<void> {
  if (!s.onFeed || !s.hiddenItems?.length) return;
  const day = dateKey();
  let seen = counted.get(day);
  if (!seen) {
    counted.clear();
    seen = new Set();
    counted.set(day, seen);
  }
  const fresh = s.hiddenItems.filter((h) => !seen.has(h.id));
  if (!fresh.length) return;
  for (const h of fresh) seen.add(h.id);
  const stats = await statsItem.getValue();
  const today = stats[day] ?? { hidden: 0, seen: 0 };
  const keep = Object.fromEntries(Object.entries(stats).filter(([d]) => d >= dateKey(new Date(Date.now() - 30 * 86_400_000))));
  await statsItem.setValue({ ...keep, [day]: { hidden: today.hidden + fresh.length, seen: today.seen } });
}

export async function updateBadge(tabId: number, s: TabState): Promise<void> {
  const settings = await readSettingsSafe();
  const action = browser.action;
  const count = s.onFeed && !s.paused ? s.counts.hiddenTotal : 0;
  const text = settings.display.badgeCount && count > 0 ? (count > 99 ? '99+' : String(count)) : '';
  await action.setBadgeText({ tabId, text }).catch(() => undefined);
  await action.setBadgeBackgroundColor({ tabId, color: '#0B7A75' }).catch(() => undefined);
  await action.setBadgeTextColor?.({ tabId, color: '#FFFFFF' })?.catch(() => undefined);
  const site = s.platform === 'facebook' ? 'Facebook' : s.platform === 'linkedin' ? 'LinkedIn' : null;
  const title = !site
    ? 'unAlgorithm'
    : s.paused
      ? `unAlgorithm is paused on ${site}`
      : s.health.status === 'broken'
        ? `unAlgorithm: ${site}'s layout looks different, so nothing is hidden`
        : `unAlgorithm: ${count} post${count === 1 ? '' : 's'} hidden on this page`;
  await action.setTitle({ tabId, title }).catch(() => undefined);
  const paused = !!site && s.paused;
  await action
    .setIcon({
      tabId,
      path: paused ? { 16: '/paused/16.png', 32: '/paused/32.png' } : { 16: '/icon/16.png', 32: '/icon/32.png' },
    })
    .catch(() => undefined);
}

/** A closed tab's live state and its fact-checks go with it. */
export async function forgetTab(tabId: number): Promise<void> {
  await Promise.all([tabStateItem(tabId).removeValue(), forgetFactchecks(tabId)]);
}
