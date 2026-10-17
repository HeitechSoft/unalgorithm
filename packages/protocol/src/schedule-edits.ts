/**
 * One task's price change as an edit of the dated schedule (decision PD3): "from date D, this card" lasts until that
 * task's next scheduled change; cancelling restores the card before D; moving is a cancel plus the same card from the
 * new date. Pure: never mutates its input, returns new frozen entries, and checks nothing. An edit that breaks a rule
 * returns a schedule the rules refuse, and the caller always runs `priceScheduleChangeIssues(base, head, now)` on it (the
 * server on every save, the Pricing page as it is filled in): one rule implementation, never a second in here.
 */
import {
  type CreditPriceCard,
  type CreditPriceSchedule,
  type CreditPriceScheduleEntry,
  type CreditTask,
  earliestRaise,
  nextMidnight,
  PRICE_NOTICE_DAYS,
  priceCardsAt,
  retailMicros,
  sameTaskCard,
} from './billing.ts';

/** Same multiplier, reference model, reference cost, unit and hold cap; two missing cards are the same. */
export { sameTaskCard };

type Card = Readonly<CreditPriceCard>;
type Entry = Readonly<CreditPriceScheduleEntry>;
type Cards = Readonly<Record<string, Card | undefined>>;

const cardsOf = (entry: Entry): Cards => entry.cards;

/** The task's card in `entry`, or null when the entry (or a missing one) does not price it. */
const cardIn = (entry: Entry | undefined, task: string): Card | null => (entry ? cardsOf(entry)[task] : undefined) ?? null;

function entryWith(effectiveFrom: string, cards: Cards): Entry {
  return Object.freeze({ effectiveFrom, cards: Object.freeze({ ...cards }) as unknown as CreditPriceScheduleEntry['cards'] });
}

/** The same task keys, and per task `sameTaskCard`. */
function sameEntryCards(a: Entry, b: Entry): boolean {
  const x = cardsOf(a);
  const y = cardsOf(b);
  const tasks = Object.keys(x);
  return (
    tasks.length === Object.keys(y).length && tasks.every((task) => Object.hasOwn(y, task) && sameTaskCard(x[task], y[task]))
  );
}

/**
 * `schedule` with `task` priced by `card` from `from` (null: not priced), until that task's next scheduled change:
 * 1. no entry at `from` → insert one there whose cards are a copy of the entry in effect at `from`;
 * 2. old = the task's card in the entry at `from` (possibly missing);
 * 3. walking the entries from `from` on, oldest first: while an entry's card for `task` is `sameTaskCard` to `old`, it
 *    becomes `card` (or the task is removed for null); stop at the first entry whose card differs (a later change);
 * 4. drop every entry at or after `from` whose cards equal the entry before it's (same task keys, `sameTaskCard` each).
 * Entries before `from` are returned as the same objects. A frozen `card` is used as it is; any other is copied.
 */
export function withTaskCard(
  schedule: CreditPriceSchedule,
  task: CreditTask,
  from: string,
  card: CreditPriceCard | null,
): CreditPriceSchedule {
  const next: Card | null = card === null || Object.isFrozen(card) ? card : Object.freeze({ ...card });
  const entries: Entry[] = [...schedule];

  let start = entries.findIndex((entry) => entry.effectiveFrom === from);
  if (start === -1) {
    const t = Date.parse(from);
    const later = entries.findIndex((entry) => Date.parse(entry.effectiveFrom) > t);
    start = later === -1 ? entries.length : later;
    // A date that does not parse goes last (the shape rules refuse it); an empty schedule has no cards to copy.
    const inEffect = entries.length === 0 ? undefined : Number.isNaN(t) ? entries.at(-1) : priceCardsAt(new Date(t), schedule);
    entries.splice(start, 0, entryWith(from, inEffect ? cardsOf(inEffect) : {}));
  }

  const old = cardIn(entries[start], task);
  for (let i = start; i < entries.length; i += 1) {
    const entry = entries[i] as Entry;
    if (!sameTaskCard(cardIn(entry, task), old)) break;
    const others = Object.fromEntries(Object.entries(cardsOf(entry)).filter(([key]) => key !== task));
    entries[i] = entryWith(entry.effectiveFrom, next === null ? others : { ...cardsOf(entry), [task]: next });
  }

  const result = entries.slice(0, start);
  for (const entry of entries.slice(start)) {
    const before = result.at(-1);
    if (before === undefined || !sameEntryCards(before, entry)) result.push(entry);
  }
  return Object.freeze(result);
}

/**
 * Undoes the scheduled change of `task` at `at`: `withTaskCard` with the card in effect just before `at` (or null). Null
 * when no entry at `at` changes `task` (nothing to cancel).
 */
export function cancelTaskChange(schedule: CreditPriceSchedule, task: CreditTask, at: string): CreditPriceSchedule | null {
  const i = schedule.findIndex((entry) => entry.effectiveFrom === at);
  if (i === -1) return null;
  const before = cardIn(schedule[i - 1], task);
  if (sameTaskCard(cardIn(schedule[i], task), before)) return null;
  return withTaskCard(schedule, task, at, before);
}

/** `cancelTaskChange` at `from`, then the same card from `to`. Null when there is nothing to move. */
export function moveTaskChange(
  schedule: CreditPriceSchedule,
  task: CreditTask,
  from: string,
  to: string,
): CreditPriceSchedule | null {
  const cancelled = cancelTaskChange(schedule, task, from);
  if (cancelled === null) return null;
  return withTaskCard(
    cancelled,
    task,
    to,
    cardIn(
      schedule.find((entry) => entry.effectiveFrom === from),
      task,
    ),
  );
}

export interface ScheduledTaskChange {
  effectiveFrom: string;
  /** The task's card from `effectiveFrom`; null when the entry takes the task off. */
  card: Readonly<CreditPriceCard> | null;
  /** The card in effect just before it; null when the task had no price (a first card). */
  before: Readonly<CreditPriceCard> | null;
}

/**
 * Entries after `now` whose card for `task` differs from the card in effect just before them, oldest first. An entry
 * that changes several tasks at once is listed for each task it changes. `RangeError` for an invalid Date.
 */
export function scheduledTaskChanges(schedule: CreditPriceSchedule, task: CreditTask, now: Date): ScheduledTaskChange[] {
  const t = now.getTime();
  if (Number.isNaN(t)) throw new RangeError('The instant must be a valid Date.');
  const changes: ScheduledTaskChange[] = [];
  schedule.forEach((entry, i) => {
    if (!(Date.parse(entry.effectiveFrom) > t)) return;
    const card = cardIn(entry, task);
    const before = cardIn(schedule[i - 1], task);
    if (!sameTaskCard(card, before)) changes.push({ effectiveFrom: entry.effectiveFrom, card, before });
  });
  return changes;
}

export type CardChangeKind = 'first' | 'same' | 'raise' | 'cut' | 'neutral';

/** The price per 1,000 units a card publishes; undefined for a card the shape rules refuse. */
function retail(card: Card): number | undefined {
  try {
    return retailMicros(card.referenceCostMicrosPer1000, card.multiplier);
  } catch {
    return undefined;
  }
}

/**
 * first: before is null; same: sameTaskCard; raise: the multiplier, the price per 1,000 units (`retailMicros(cost,
 * multiplier)`) or the hold cap is higher (what `priceRaiseIssues` calls a raise); cut: none is higher and one is
 * lower; neutral: none is higher or lower (only the reference model or the split of an unchanged price changed). A task
 * taken off (`after` null, which the shape rules refuse) charges nothing more: a cut.
 */
export function cardChangeKind(before: CreditPriceCard | null, after: CreditPriceCard | null): CardChangeKind {
  if (sameTaskCard(before, after)) return 'same';
  if (before == null) return 'first';
  if (after == null) return 'cut';
  const figures: [number | undefined, number | undefined][] = [
    [before.multiplier, after.multiplier],
    [retail(before), retail(after)],
    [before.maxChargeMicros, after.maxChargeMicros],
  ];
  const compared = figures.filter((pair): pair is [number, number] => pair[0] !== undefined && pair[1] !== undefined);
  if (compared.some(([was, is]) => is > was)) return 'raise';
  if (compared.some(([was, is]) => is < was)) return 'cut';
  return 'neutral';
}

/** The earliest date a change of that kind may start at `now`: raise → `earliestRaise`; every other kind → `nextMidnight`. */
export function earliestStart(kind: CardChangeKind, now: Date, noticeDays: number = PRICE_NOTICE_DAYS): string {
  return kind === 'raise' ? earliestRaise(now, noticeDays) : nextMidnight(now);
}
