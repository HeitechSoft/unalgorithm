import { addUsage, costMicros, type NormalizedUsage, ZERO_USAGE } from '@unalgorithm/protocol';
import { dateKey } from './util.ts';

export interface ModelUsage {
  calls: number;
  usage: NormalizedUsage;
}

export interface DayUsage {
  /** Posts classified by sources that count toward the daily cap. */
  posts: number;
  calls: number;
  failedCalls: number;
  byModel: Record<string, ModelUsage>;
}

/** date (YYYY-MM-DD) → usage. Kept for 30 days. */
export type UsageLedger = Record<string, DayUsage>;

const KEEP_DAYS = 30;

export function emptyDay(): DayUsage {
  return { posts: 0, calls: 0, failedCalls: 0, byModel: {} };
}

/** Record one AI call, including failed ones (tokens were still spent). */
export function recordUsage(
  ledger: UsageLedger,
  entry: { model: string; usage: NormalizedUsage; posts: number; failed?: boolean; now?: Date },
): UsageLedger {
  const now = entry.now ?? new Date();
  const date = dateKey(now);
  const day = ledger[date] ?? emptyDay();
  const prev = day.byModel[entry.model] ?? { calls: 0, usage: ZERO_USAGE };
  const next: UsageLedger = {
    ...ledger,
    [date]: {
      posts: day.posts + entry.posts,
      calls: day.calls + 1,
      failedCalls: day.failedCalls + (entry.failed ? 1 : 0),
      byModel: { ...day.byModel, [entry.model]: { calls: prev.calls + 1, usage: addUsage(prev.usage, entry.usage) } },
    },
  };
  const keep = new Set(Array.from({ length: KEEP_DAYS }, (_, i) => dateKey(new Date(now.getTime() - i * 86_400_000))));
  for (const d of Object.keys(next)) if (!keep.has(d)) delete next[d];
  return next;
}

export function dayUsage(ledger: UsageLedger, now = new Date()): DayUsage {
  return ledger[dateKey(now)] ?? emptyDay();
}

/** Estimated spend for a day in micro-dollars; undefined when a model has no known price. */
export function dayCostMicros(day: DayUsage): number | undefined {
  let total = 0;
  for (const [model, m] of Object.entries(day.byModel)) {
    const c = costMicros(model, m.usage);
    if (c === undefined) return undefined;
    total += c;
  }
  return total;
}

/** "about 4¢", "about $1.20", "less than 1¢". */
export function formatApproxCost(micros: number): string {
  const cents = micros / 10_000;
  if (cents < 1) return 'less than 1¢';
  if (cents < 100) return `about ${Math.round(cents)}¢`;
  return `about $${(cents / 100).toFixed(2)}`;
}
