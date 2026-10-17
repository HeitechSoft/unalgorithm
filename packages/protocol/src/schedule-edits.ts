/**
 * One task's price change as an edit of the dated schedule (decision PD3): "from date D, this card" lasts until that
 * task's next scheduled change; cancelling restores the card before D; moving starts the same change at another date
 * between the task's changes before and after it, so a temporary price keeps its end. Pure: never mutates its input,
 * returns new frozen entries, and checks no price rule. An edit that breaks a rule returns a schedule the rules refuse,
 * and the caller always runs `priceScheduleChangeIssues(base, head, now)` on it (the server on every save, the Pricing
 * page as it is filled in): one rule implementation, never a second in here.
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

/** A frozen card as it is; any other copied and frozen. */
const frozenCard = (card: Card | null): Card | null =>
  card === null || Object.isFrozen(card) ? card : Object.freeze({ ...card });

/** `entry` with `task` priced by `card` (a frozen card or null: the task is removed). */
function entryWithTaskCard(entry: Entry, task: CreditTask, card: Card | null): Entry {
  const others = Object.fromEntries(Object.entries(cardsOf(entry)).filter(([key]) => key !== task));
  return entryWith(entry.effectiveFrom, card === null ? others : { ...cardsOf(entry), [task]: card });
}

/**
 * The index of the entry at `from` in `entries` (a copy of `schedule`), first inserting one there whose cards are a copy
 * of the entry in effect at `from` when there is none.
 */
function entryAt(entries: Entry[], schedule: CreditPriceSchedule, from: string): number {
  const at = entries.findIndex((entry) => entry.effectiveFrom === from);
  if (at !== -1) return at;
  const t = Date.parse(from);
  const later = entries.findIndex((entry) => Date.parse(entry.effectiveFrom) > t);
  const start = later === -1 ? entries.length : later;
  // A date that does not parse goes last (the shape rules refuse it); an empty schedule has no cards to copy.
  const inEffect = entries.length === 0 ? undefined : Number.isNaN(t) ? entries.at(-1) : priceCardsAt(new Date(t), schedule);
  entries.splice(start, 0, entryWith(from, inEffect ? cardsOf(inEffect) : {}));
  return start;
}

/** `entries`, frozen, without every entry from index `start` on whose cards equal the entry before it's. */
function withoutRepeats(entries: readonly Entry[], start: number): CreditPriceSchedule {
  const result = entries.slice(0, start);
  for (const entry of entries.slice(start)) {
    const before = result.at(-1);
    if (before === undefined || !sameEntryCards(before, entry)) result.push(entry);
  }
  return Object.freeze(result);
}

/** Whether the entry at index `i` prices `task` differently from the entry before it (no entry before: no card). */
const changesTask = (schedule: CreditPriceSchedule, task: CreditTask, i: number): boolean =>
  !sameTaskCard(cardIn(schedule[i], task), cardIn(schedule[i - 1], task));

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
  const next = frozenCard(card);
  const entries: Entry[] = [...schedule];
  const start = entryAt(entries, schedule, from);
  const old = cardIn(entries[start], task);
  for (let i = start; i < entries.length; i += 1) {
    const entry = entries[i] as Entry;
    if (!sameTaskCard(cardIn(entry, task), old)) break;
    entries[i] = entryWithTaskCard(entry, task, next);
  }
  return withoutRepeats(entries, start);
}

/**
 * Undoes the scheduled change of `task` at `at`: `withTaskCard` with the card in effect just before `at` (or null). Null
 * when no entry at `at` changes `task` (nothing to cancel).
 */
export function cancelTaskChange(schedule: CreditPriceSchedule, task: CreditTask, at: string): CreditPriceSchedule | null {
  const i = schedule.findIndex((entry) => entry.effectiveFrom === at);
  if (i === -1 || !changesTask(schedule, task, i)) return null;
  return withTaskCard(schedule, task, at, cardIn(schedule[i - 1], task));
}

/**
 * The scheduled change of `task` at `from` starting at `to` instead, still until the task's next change, so the end of a
 * temporary price (the later entry that brings the card back) keeps its date and card:
 * 1. insert an entry at `to` as `withTaskCard` does;
 * 2. the entries from `to` up to `from` take the moved card (moved sooner), or the entries from `from` up to `to` take
 *    the card in effect just before `from` (moved later); every other entry and task keeps its card;
 * 3. drop the entries left changing nothing, as `withTaskCard` does.
 * Null when no entry at `from` changes `task` (nothing to move), and when `to` is not a date after the task's change
 * before `from` and before its next change after `from`: a move never lands on or crosses another change of the task.
 */
export function moveTaskChange(
  schedule: CreditPriceSchedule,
  task: CreditTask,
  from: string,
  to: string,
): CreditPriceSchedule | null {
  const i = schedule.findIndex((entry) => entry.effectiveFrom === from);
  if (i === -1 || !changesTask(schedule, task, i)) return null;
  const moved = frozenCard(cardIn(schedule[i], task));
  const before = frozenCard(cardIn(schedule[i - 1], task));

  let previous = i - 1;
  while (previous >= 0 && !changesTask(schedule, task, previous)) previous -= 1;
  const next = schedule.findIndex((entry, j) => j > i && !sameTaskCard(cardIn(entry, task), moved));
  const t = Date.parse(to);
  const after = previous === -1 ? Number.NEGATIVE_INFINITY : Date.parse((schedule[previous] as Entry).effectiveFrom);
  const until = next === -1 ? Number.POSITIVE_INFINITY : Date.parse((schedule[next] as Entry).effectiveFrom);
  if (!(t > after && t < until)) return null;

  const entries: Entry[] = [...schedule];
  const at = entryAt(entries, schedule, to);
  const start = entries.findIndex((entry) => entry.effectiveFrom === from);
  const [first, end, card] = at < start ? [at, start, moved] : [start, at, before];
  for (let k = first; k < end; k += 1) entries[k] = entryWithTaskCard(entries[k] as Entry, task, card);
  return withoutRepeats(entries, first);
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
