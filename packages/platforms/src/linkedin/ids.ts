import type { AdapterIds } from '../types.ts';

/**
 * Every id the LinkedIn adapter can emit (ADR 0009 §4). Each must be in the protocol registry
 * (`packages/protocol/src/report-codes.ts`), and the Cloud must know it before an extension that sends it ships.
 */
export const LINKEDIN_IDS = {
  /** Evidence for a signal, shown in "Why?" and counted in reports. */
  detectors: [
    'li.promoted.age-slot',
    'li.promoted.header',
    'li.promoted.actor',
    'li.promoted.near',
    'li.age-slot.no-age',
    'li.header.suggested',
    'li.header.activity',
    'li.header.repost',
    'li.follow-button',
    'li.group.join-button',
  ],
  /**
   * Things noticed that aren't evidence: a near-miss label, an unknown header line, a likely ad without its label, an
   * item holding several posts, and which locator found each part of a post when LinkedIn's class names didn't.
   */
  observations: [
    'li.label.promoted.near',
    'li.label.suggested.near',
    'li.slot.age.unrecognised',
    'li.header.unknown',
    'li.ad-cue',
    'li.item.multi-post',
    'li.slot.actor.aria',
    'li.slot.actor.structure',
    'li.slot.header.testid',
    'li.slot.header.structure',
    'li.slot.age.structure',
    'li.slot.text.testid',
    'li.slot.text.structure',
    'li.slot.action-bar.aria',
    'li.slot.action-bar.structure',
  ],
  /** Item discovery strategies, cheapest first (`discover.ts`). */
  strategies: ['li.items.card-key', 'li.items.feed-list', 'li.items.anatomy', 'li.items.sr-heading'],
  /** The landmark counts `probe` returns. */
  landmarks: ['main', 'feedList', 'postRoots', 'authorMenus', 'textBoxes', 'signedIn'],
} as const satisfies AdapterIds;
