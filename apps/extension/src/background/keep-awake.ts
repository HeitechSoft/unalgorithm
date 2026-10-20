import { browser } from 'wxt/browser';
import { browserKind } from '../lib/browser-kind.ts';

/** Under Firefox's 30-second idle limit for an event page (`extensions.background.idle.timeout`). */
export const KEEP_AWAKE_MS = 20_000;

/**
 * Keeps Firefox's event page running until `work` settles (ADR 0008). Firefox ends it 30 seconds after its last
 * extension API call, waits once more for a message still being answered, and doesn't count a pending `fetch`, so a
 * fact-check or a batch an AI takes a minute over would be cut off mid-answer. A cheap API call every 20 seconds
 * counts as activity. Chrome's and Edge's service workers wait for a message's answer themselves: `work` is returned
 * as it is there.
 */
export function keepAwake<T>(work: Promise<T>): Promise<T> {
  if (browserKind() !== 'firefox') return work;
  const timer = setInterval(() => void browser.runtime.getPlatformInfo().catch(() => undefined), KEEP_AWAKE_MS);
  return work.finally(() => clearInterval(timer));
}
