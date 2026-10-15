/**
 * How many error-level log lines the server wrote lately (R43), for the admin page's status (CL4-14) and the alert on
 * errors (CL4-15). Counts per UTC minute, in memory and per process: one server process serves an instance, as the
 * limits assume (CL1-21). Only counts are kept, never a line.
 */

export const ERROR_WINDOW_MINUTES = 15;

const MINUTE_MS = 60_000;

export interface ErrorWindow {
  /** Counts one error-level log line at `now` (ms since the epoch). */
  record(now?: number): void;
  /** Error lines in the current UTC minute and the 14 before it. */
  count(now?: number): number;
}

export function createErrorWindow(): ErrorWindow {
  /** Lines per minute since the epoch; `record` drops minutes outside the window, so at most 15 entries. */
  const minutes = new Map<number, number>();
  const minuteOf = (now: number) => Math.floor(now / MINUTE_MS);
  return {
    record(now = Date.now()) {
      const minute = minuteOf(now);
      for (const key of minutes.keys()) if (key <= minute - ERROR_WINDOW_MINUTES) minutes.delete(key);
      minutes.set(minute, (minutes.get(minute) ?? 0) + 1);
    },
    count(now = Date.now()) {
      const minute = minuteOf(now);
      let total = 0;
      for (const [key, n] of minutes) if (key > minute - ERROR_WINDOW_MINUTES && key <= minute) total += n;
      return total;
    },
  };
}
