import type { AdapterIds } from '../types.ts';

/**
 * Every id the Facebook adapter can emit (ADR 0009 §4). Each must be in the protocol registry
 * (`packages/protocol/src/report-codes.ts`), which the Cloud deploys before an extension that sends a new id ships;
 * a test checks it. The detector and observation types below keep the adapter from emitting anything else.
 */
export const FACEBOOK_IDS = {
  detectors: [
    'fb.follow-button',
    'fb.header.activity',
    'fb.header.suggested',
    'fb.join-button',
    'fb.reshare',
    'fb.sponsored.adlink',
    'fb.sponsored.aria-label',
    'fb.sponsored.cta',
    'fb.sponsored.labelledby',
    'fb.sponsored.no-timestamp',
    'fb.sponsored.paid-partnership',
    'fb.sponsored.rendered-label',
    'fb.sponsored.slot-label',
    // An ad label that nearly matches ("Ad · Paid"): medium, so it hides only with another signal.
    'fb.sponsored.near',
    // "Sponsored" as the name of a button in the post's header.
    'fb.sponsored.header',
  ],
  observations: [
    'fb.label.sponsored.near',
    'fb.slot.age.unrecognised',
    'fb.header.unknown',
    'fb.item.multi-post',
    // Counted by the controller from `pending` results with `offscreen: true`; a pending result carries no observations.
    'fb.offscreen',
    // A fallback locator found a part of the post (slots.ts): it still works, but the fast path is gone.
    'fb.slot.actor.structure',
    'fb.slot.text.structure',
    'fb.slot.header.structure',
    'fb.slot.header-buttons.structure',
    'fb.slot.nested-post.structure',
    'fb.slot.action-bar.aria',
  ],
  /** Cheapest first; the first two are the layouts before and since 2026 (discover.ts). */
  strategies: ['fb.items.role-feed', 'fb.items.heading-list', 'fb.items.posinset', 'fb.items.anatomy'],
  /** `probe()` keys. */
  landmarks: ['main', 'feeds', 'lists', 'items', 'posinset', 'messages', 'profileNames', 'homeNav', 'signedIn'],
} as const satisfies AdapterIds;

export type FacebookDetector = (typeof FACEBOOK_IDS.detectors)[number];
export type FacebookObservation = (typeof FACEBOOK_IDS.observations)[number];
export type FacebookStrategy = (typeof FACEBOOK_IDS.strategies)[number];
export type FacebookLandmark = (typeof FACEBOOK_IDS.landmarks)[number];
