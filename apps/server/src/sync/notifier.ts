/**
 * Wakes long-polls (CL3-08): a changes request with nothing new waits for a push to its space, so another computer
 * updates within seconds instead of at its next pull. In process: one server process per deployment today (as CL1-21's
 * rate limits assume). A server that ran as several processes would need Postgres `LISTEN/NOTIFY` here.
 *
 * Holds space ids only, in memory, and logs nothing.
 */

/** Registered subscriptions a space holds at most, by default: an account's devices waiting at once. */
const DEFAULT_MAX_WAITERS_PER_SPACE = 4;

export interface SpaceSubscription {
  /**
   * True: a notify arrived after subscribe (at once if one already has); false: timed out or aborted, or cancelled
   * before a notify. Call it once.
   */
  wait(ms: number, signal?: AbortSignal): Promise<boolean>;
  /** Unregisters, and ends a wait in progress with false. Idempotent. */
  cancel(): void;
}

export interface SpaceNotifier {
  /** Wakes every registered subscription of that space. */
  notify(spaceId: string): void;
  /** Taken before the read, so a notify between the read and the wait is not lost. */
  subscribe(spaceId: string): SpaceSubscription;
  /** Shorthand: `subscribe(spaceId).wait(ms, signal)`, cancelled when it settles. */
  wait(spaceId: string, ms: number, signal?: AbortSignal): Promise<boolean>;
  /** Registered subscriptions of that space. */
  waiting(spaceId: string): number;
}

/** One subscription's state. `settle` is set while its wait is in progress. */
interface Waiter {
  notified: boolean;
  done: boolean;
  settle: ((woken: boolean) => void) | undefined;
}

/**
 * A subscription is registered from `subscribe` until its wait settles (woken, timed out or aborted) or it is cancelled;
 * settling clears its timer. On a space that already has `maxWaitersPerSpace` registered, a new subscription is not
 * registered, not counted and never woken: its wait still runs its time and resolves false. It does not answer at once,
 * since the extension's long-poll loop runs back to back (CL3-20): an immediate empty answer would make a fifth device
 * spin through the account's shared rate limit in about a second. No subscription is ever evicted.
 */
export function createSpaceNotifier(opts: { maxWaitersPerSpace?: number } = {}): SpaceNotifier {
  const max = opts.maxWaitersPerSpace ?? DEFAULT_MAX_WAITERS_PER_SPACE;
  const spaces = new Map<string, Set<Waiter>>();

  const unregister = (spaceId: string, waiter: Waiter) => {
    const waiters = spaces.get(spaceId);
    if (!waiters?.delete(waiter)) return;
    if (waiters.size === 0) spaces.delete(spaceId);
  };

  const subscribe = (spaceId: string): SpaceSubscription => {
    const waiter: Waiter = { notified: false, done: false, settle: undefined };
    const waiters = spaces.get(spaceId) ?? new Set<Waiter>();
    // Decided now: a full space leaves this one out for good, even once others leave.
    if (waiters.size < max) spaces.set(spaceId, waiters.add(waiter));

    const finish = () => {
      waiter.done = true;
      unregister(spaceId, waiter);
    };
    return {
      wait(ms, signal) {
        if (waiter.done || waiter.notified || signal?.aborted) {
          finish();
          return Promise.resolve(waiter.notified);
        }
        return new Promise<boolean>((resolve) => {
          const settle = (woken: boolean) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            waiter.settle = undefined;
            finish();
            resolve(woken);
          };
          const onAbort = () => settle(false);
          const timer = setTimeout(onAbort, ms);
          signal?.addEventListener('abort', onAbort, { once: true });
          waiter.settle = settle;
        });
      },
      cancel() {
        if (waiter.settle) waiter.settle(false);
        else finish();
      },
    };
  };

  return {
    notify(spaceId) {
      // A copy: each woken waiter leaves the set as it settles.
      for (const waiter of [...(spaces.get(spaceId) ?? [])]) {
        waiter.notified = true;
        waiter.settle?.(true);
      }
    },
    subscribe,
    wait: (spaceId, ms, signal) => subscribe(spaceId).wait(ms, signal),
    waiting: (spaceId) => spaces.get(spaceId)?.size ?? 0,
  };
}
