import { describe, expect, it } from 'vitest';
import {
  CREDIT_PRICE_SCHEDULE,
  CREDIT_TASKS,
  type CreditPriceCard,
  type CreditPriceSchedule,
  type CreditPriceScheduleEntry,
  cancelTaskChange,
  cardChangeKind,
  earliestStart,
  moveTaskChange,
  priceScheduleChangeIssues,
  priceScheduleIssues,
  sameTaskCard,
  scheduledTaskChanges,
  taskPriceAt,
  withTaskCard,
} from '../src/index.ts';

/** Fixed instants: no test here reads the clock. Both entries of S are in effect at NOW. */
const NOW = new Date('2026-11-02T12:00:00Z');
const S = CREDIT_PRICE_SCHEDULE;
const LAUNCH = S[0] as CreditPriceScheduleEntry;
const OCT_18_ENTRY = S[1] as CreditPriceScheduleEntry;
const CLASSIFY = LAUNCH.cards.classify;
const FC = OCT_18_ENTRY.cards.factcheck as CreditPriceCard;
const PC = OCT_18_ENTRY.cards.perspectives as CreditPriceCard;
const OCT_1 = '2026-10-01T00:00:00Z';
const OCT_18 = '2026-10-18T00:00:00Z';
const NOV_3 = '2026-11-03T00:00:00Z';
const NOV_10 = '2026-11-10T00:00:00Z';
const DEC_3 = '2026-12-03T00:00:00Z';
const DEC_10 = '2026-12-10T00:00:00Z';

const cutCard: CreditPriceCard = { ...FC, maxChargeMicros: 300_000 };
const raisedCard: CreditPriceCard = { ...FC, multiplier: 2.5 };
const cheaperClassify: CreditPriceCard = { ...CLASSIFY, multiplier: 1.5 };
/** S plus a scheduled 2026-12-10 entry that raises factcheck's multiplier to 2.5 (its cap stays 400,000). */
const S2: CreditPriceSchedule = [...S, { effectiveFrom: DEC_10, cards: { ...OCT_18_ENTRY.cards, factcheck: raisedCard } }];

const dates = (schedule: CreditPriceSchedule) => schedule.map((entry) => entry.effectiveFrom);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

describe('edits', () => {
  it('test_with_task_card_inserts_entry_copying_cards_in_effect', () => {
    const head = withTaskCard(S, 'factcheck', NOV_3, cutCard);
    expect(dates(head)).toEqual([OCT_1, OCT_18, NOV_3]);
    expect(head[0]).toBe(S[0]);
    expect(head[1]).toBe(S[1]);
    const added = head[2] as CreditPriceScheduleEntry;
    expect(added.cards.classify).toEqual(OCT_18_ENTRY.cards.classify);
    expect(added.cards.perspectives).toEqual(OCT_18_ENTRY.cards.perspectives);
    expect(added.cards.factcheck).toEqual(cutCard);
    expect(added.cards.factcheck?.maxChargeMicros).toBe(300_000);
    expect(Object.keys(added.cards).sort()).toEqual(['classify', 'factcheck', 'perspectives']);
    expect(isDeepFrozen(head)).toBe(true);
    expect(priceScheduleChangeIssues(S, head, NOW)).toEqual([]);

    // An entry at that date already is edited in place, not added to.
    const again = withTaskCard(head, 'factcheck', NOV_3, { ...FC, maxChargeMicros: 350_000 });
    expect(dates(again)).toEqual([OCT_1, OCT_18, NOV_3]);
    expect(again[2]?.cards.factcheck?.maxChargeMicros).toBe(350_000);
    // The card in effect before it, set again, leaves an entry that changes nothing: it is dropped.
    expect(withTaskCard(head, 'factcheck', NOV_3, FC)).toEqual(S);
    // The same card as in effect adds nothing.
    expect(withTaskCard(S, 'factcheck', NOV_3, { ...FC })).toEqual(S);
  });

  it('test_with_task_card_carries_until_next_change_of_task', () => {
    expect(priceScheduleIssues(S2)).toEqual([]);
    // A cut from 2026-11-03 ends at factcheck's next scheduled change: the 2026-12-10 entry keeps its own card.
    const cut = withTaskCard(S2, 'factcheck', NOV_3, cutCard);
    expect(dates(cut)).toEqual([OCT_1, OCT_18, NOV_3, DEC_10]);
    expect(cut[2]?.cards.factcheck).toEqual(cutCard);
    expect(cut[3]).toBe(S2[2]);
    expect(cut[3]?.cards.factcheck?.maxChargeMicros).toBe(400_000);
    expect(cut[3]?.cards.factcheck?.multiplier).toBe(2.5);

    // A classify change from 2026-11-03 is carried into the 2026-12-10 entry, which does not change classify.
    const classify = withTaskCard(S2, 'classify', NOV_3, cheaperClassify);
    expect(dates(classify)).toEqual([OCT_1, OCT_18, NOV_3, DEC_10]);
    expect(classify[2]?.cards.classify).toEqual(cheaperClassify);
    expect(classify[3]?.cards.classify).toEqual(cheaperClassify);
    expect(classify[3]?.cards.factcheck).toEqual(raisedCard);
    expect(classify[3]?.cards.perspectives).toBe(PC);
    expect(priceScheduleIssues(classify)).toEqual([]);

    // The 2026-12-10 raise brought forward to 2026-11-03: the later entry now repeats it and is dropped.
    const sooner = withTaskCard(S2, 'factcheck', NOV_3, raisedCard);
    expect(dates(sooner)).toEqual([OCT_1, OCT_18, NOV_3]);
    expect(sooner[2]?.cards.factcheck).toEqual(raisedCard);

    // Entries before the date are the same objects.
    for (const edited of [cut, classify, sooner]) {
      expect(edited[0]).toBe(S2[0]);
      expect(edited[1]).toBe(S2[1]);
    }
  });

  it('test_cancel_and_move_task_change', () => {
    const cut = withTaskCard(S, 'factcheck', NOV_3, cutCard);
    // Cancelling restores the card before the date; the entry left changes nothing and is dropped.
    expect(cancelTaskChange(cut, 'factcheck', NOV_3)).toEqual(S);
    // Nothing to cancel: no entry at the date, or one that does not change the task.
    expect(cancelTaskChange(S, 'factcheck', NOV_3)).toBeNull();
    expect(cancelTaskChange(cut, 'classify', NOV_3)).toBeNull();
    expect(cancelTaskChange(cut, 'factcheck', NOV_10)).toBeNull();

    const moved = moveTaskChange(cut, 'factcheck', NOV_3, NOV_10) as CreditPriceSchedule;
    expect(dates(moved)).toEqual([OCT_1, OCT_18, NOV_10]);
    expect(moved[0]).toBe(S[0]);
    expect(moved[1]).toBe(S[1]);
    expect(moved[2]?.cards.factcheck).toEqual(cutCard);
    expect(priceScheduleChangeIssues(S, moved, NOW)).toEqual([]);
    // The edits check nothing: once the cut is published, moving it later raises the cap from 2026-11-03 to 2026-11-10,
    // and the rules refuse that.
    expect(priceScheduleChangeIssues(cut, moved, NOW).map((issue) => issue.code)).toEqual(['cap-raise']);
    expect(moveTaskChange(S, 'factcheck', NOV_3, NOV_10)).toBeNull();

    // In an entry that changes two tasks, cancelling one keeps the other's change.
    const both = withTaskCard(cut, 'classify', NOV_3, cheaperClassify);
    const classifyOnly = cancelTaskChange(both, 'factcheck', NOV_3) as CreditPriceSchedule;
    expect(dates(classifyOnly)).toEqual([OCT_1, OCT_18, NOV_3]);
    expect(classifyOnly[2]?.cards.classify).toEqual(cheaperClassify);
    expect(classifyOnly[2]?.cards.factcheck).toBe(FC);

    // A later scheduled raise is cancelled back to the card before it; moving it keeps the raise.
    expect(cancelTaskChange(S2, 'factcheck', DEC_10)).toEqual(S);
    const later = moveTaskChange(S2, 'factcheck', DEC_10, '2026-12-20T00:00:00Z') as CreditPriceSchedule;
    expect(dates(later)).toEqual([OCT_1, OCT_18, '2026-12-20T00:00:00Z']);
    expect(later[2]?.cards.factcheck).toEqual(raisedCard);
  });

  it('test_move_keeps_the_end_of_a_temporary_change', () => {
    const DEC_5 = '2026-12-05T00:00:00Z';
    const DEC_15 = '2026-12-15T00:00:00Z';
    const JAN_10 = '2027-01-10T00:00:00Z';
    const JAN_20 = '2027-01-20T00:00:00Z';
    const MAR_1 = '2027-03-01T00:00:00Z';

    // A temporary raise: 2.5x from 2026-12-10, back to the card before it on 2027-01-10.
    const raise = withTaskCard(withTaskCard(S, 'factcheck', DEC_10, raisedCard), 'factcheck', JAN_10, FC);
    expect(dates(raise)).toEqual([OCT_1, OCT_18, DEC_10, JAN_10]);
    expect(priceScheduleChangeIssues(S, raise, NOW)).toEqual([]);

    // Moved later or sooner, the raise still ends on 2027-01-10.
    for (const to of [DEC_15, DEC_5]) {
      const moved = moveTaskChange(raise, 'factcheck', DEC_10, to) as CreditPriceSchedule;
      expect(dates(moved), to).toEqual([OCT_1, OCT_18, to, JAN_10]);
      expect(moved[2]?.cards.factcheck).toEqual(raisedCard);
      expect(moved[3]?.cards.factcheck).toEqual(FC);
      expect(scheduledTaskChanges(moved, 'factcheck', NOW)).toEqual([
        { effectiveFrom: to, card: raisedCard, before: FC },
        { effectiveFrom: JAN_10, card: FC, before: raisedCard },
      ]);
      expect(taskPriceAt(new Date('2027-02-01T00:00:00Z'), 'factcheck', moved)).toEqual({
        offered: true,
        card: FC,
        effectiveFrom: JAN_10,
      });
      expect(priceScheduleChangeIssues(raise, moved, NOW)).toEqual([]);
      expect(isDeepFrozen(moved)).toBe(true);
    }
    // Its end moves on its own, and the raise stays where it is.
    const longer = moveTaskChange(raise, 'factcheck', JAN_10, JAN_20) as CreditPriceSchedule;
    expect(dates(longer)).toEqual([OCT_1, OCT_18, DEC_10, JAN_20]);
    expect(longer[2]?.cards.factcheck).toEqual(raisedCard);
    expect(longer[3]?.cards.factcheck).toEqual(FC);
    // Moved to its own date, nothing changes.
    expect(moveTaskChange(raise, 'factcheck', DEC_10, DEC_10)).toEqual(raise);

    // A sale: 1.5x from 2026-11-20, back to the card before it on 2026-12-20. Moved sooner, it still ends.
    const NOV_15 = '2026-11-15T00:00:00Z';
    const NOV_20 = '2026-11-20T00:00:00Z';
    const DEC_20 = '2026-12-20T00:00:00Z';
    const saleCard: CreditPriceCard = { ...FC, multiplier: 1.5 };
    const sale = withTaskCard(withTaskCard(S, 'factcheck', NOV_20, saleCard), 'factcheck', DEC_20, FC);
    expect(dates(sale)).toEqual([OCT_1, OCT_18, NOV_20, DEC_20]);
    expect(priceScheduleChangeIssues(S, sale, NOW)).toEqual([]);
    const sooner = moveTaskChange(sale, 'factcheck', NOV_20, NOV_15) as CreditPriceSchedule;
    expect(dates(sooner)).toEqual([OCT_1, OCT_18, NOV_15, DEC_20]);
    expect(sooner[2]?.cards.factcheck).toEqual(saleCard);
    expect(sooner[3]?.cards.factcheck).toEqual(FC);
    expect(priceScheduleChangeIssues(sale, sooner, NOW)).toEqual([]);

    // An end followed later by the same card again: both later changes stay.
    const again = withTaskCard(raise, 'factcheck', MAR_1, raisedCard);
    expect(dates(again)).toEqual([OCT_1, OCT_18, DEC_10, JAN_10, MAR_1]);
    const movedAgain = moveTaskChange(again, 'factcheck', DEC_10, DEC_15) as CreditPriceSchedule;
    expect(dates(movedAgain)).toEqual([OCT_1, OCT_18, DEC_15, JAN_10, MAR_1]);
    expect(movedAgain.map((entry) => entry.cards.factcheck?.multiplier)).toEqual([undefined, 2, 2.5, 2, 2.5]);

    // An end in an entry that also changes another task: that task's change stays, and so does the end.
    const shared = withTaskCard(raise, 'classify', JAN_10, cheaperClassify);
    const movedShared = moveTaskChange(shared, 'factcheck', DEC_10, DEC_15) as CreditPriceSchedule;
    expect(dates(movedShared)).toEqual([OCT_1, OCT_18, DEC_15, JAN_10]);
    expect(movedShared[2]?.cards.factcheck).toEqual(raisedCard);
    expect(movedShared[2]?.cards.classify).toEqual(CLASSIFY);
    expect(movedShared[3]?.cards.factcheck).toEqual(FC);
    expect(movedShared[3]?.cards.classify).toEqual(cheaperClassify);
  });

  it('test_move_never_crosses_another_change_of_the_task', () => {
    const JAN_10 = '2027-01-10T00:00:00Z';
    const JAN_20 = '2027-01-20T00:00:00Z';
    const raise = withTaskCard(withTaskCard(S, 'factcheck', DEC_10, raisedCard), 'factcheck', JAN_10, FC);
    // The raise can't move to or past its own end, nor its end to or before the raise.
    expect(moveTaskChange(raise, 'factcheck', DEC_10, JAN_10)).toBeNull();
    expect(moveTaskChange(raise, 'factcheck', DEC_10, JAN_20)).toBeNull();
    expect(moveTaskChange(raise, 'factcheck', JAN_10, DEC_10)).toBeNull();
    expect(moveTaskChange(raise, 'factcheck', JAN_10, NOV_10)).toBeNull();
    // Nor to or before the task's first card, nor to a date that does not parse.
    expect(moveTaskChange(raise, 'factcheck', DEC_10, OCT_18)).toBeNull();
    expect(moveTaskChange(raise, 'factcheck', DEC_10, '2026-10-10T00:00:00Z')).toBeNull();
    expect(moveTaskChange(raise, 'factcheck', DEC_10, 'soon')).toBeNull();
    // A date in the past but after the task's change before it is moved to: the rules refuse it, not the edit.
    const past = moveTaskChange(raise, 'factcheck', DEC_10, '2026-10-20T00:00:00Z') as CreditPriceSchedule;
    expect(dates(past)).toEqual([OCT_1, OCT_18, '2026-10-20T00:00:00Z', JAN_10]);
    expect(priceScheduleChangeIssues(raise, past, NOW)).not.toEqual([]);
    // Another task's change between the two dates is not in the way, and keeps its own card.
    const DEC_12 = '2026-12-12T00:00:00Z';
    const DEC_14 = '2026-12-14T00:00:00Z';
    const classify = withTaskCard(raise, 'classify', DEC_12, cheaperClassify);
    const moved = moveTaskChange(classify, 'factcheck', DEC_10, DEC_14) as CreditPriceSchedule;
    expect(dates(moved)).toEqual([OCT_1, OCT_18, DEC_12, DEC_14, JAN_10]);
    expect(moved.map((entry) => entry.cards.factcheck?.multiplier)).toEqual([undefined, 2, 2, 2.5, 2]);
    expect(moved.map((entry) => entry.cards.classify?.multiplier)).toEqual([2, 2, 1.5, 1.5, 1.5]);
    // And back again: the same schedule as before the move.
    expect(moveTaskChange(moved, 'factcheck', DEC_14, DEC_10)).toEqual(classify);
  });

  it('test_first_card_for_a_new_task_passes_rules', () => {
    const launchOnly: CreditPriceSchedule = [LAUNCH];
    const head = withTaskCard(launchOnly, 'perspectives', NOV_3, PC);
    expect(dates(head)).toEqual([OCT_1, NOV_3]);
    expect(head[0]).toBe(LAUNCH);
    expect(head[1]?.cards).toEqual({ classify: CLASSIFY, perspectives: PC });
    // The other cards are copied by identity, as the code schedule copies them.
    expect(head[1]?.cards.classify).toBe(CLASSIFY);
    expect(priceScheduleIssues(head)).toEqual([]);
    expect(priceScheduleChangeIssues(launchOnly, head, NOW)).toEqual([]);
    expect(cardChangeKind(null, PC)).toBe('first');
    expect(scheduledTaskChanges(head, 'perspectives', NOW)).toEqual([{ effectiveFrom: NOV_3, card: PC, before: null }]);
    // Cancelling a first card takes the task off again.
    expect(cancelTaskChange(head, 'perspectives', NOV_3)).toEqual(launchOnly);
    // Taking a task off with null is an edit too; the shape rules refuse it, the edit does not.
    const dropped = withTaskCard(S, 'factcheck', NOV_3, null);
    expect(dropped[2]?.cards).toEqual({ classify: CLASSIFY, perspectives: PC });
    expect(priceScheduleIssues(dropped).map((issue) => issue.code)).toEqual(['drops-task']);
  });

  it('test_edits_do_not_mutate_input', () => {
    const frozen = deepFreeze(structuredClone(S2) as CreditPriceSchedule);
    const before = structuredClone(frozen);
    const results = [
      withTaskCard(frozen, 'factcheck', NOV_3, cutCard),
      withTaskCard(frozen, 'classify', NOV_3, cheaperClassify),
      withTaskCard(frozen, 'factcheck', DEC_10, cutCard),
      withTaskCard(frozen, 'factcheck', NOV_3, null),
      withTaskCard(frozen, 'perspectives', '2026-09-01T00:00:00Z', PC),
      cancelTaskChange(frozen, 'factcheck', DEC_10),
      moveTaskChange(frozen, 'factcheck', DEC_10, NOV_10),
    ];
    expect(scheduledTaskChanges(frozen, 'factcheck', NOW)).toHaveLength(1);
    expect(frozen).toEqual(before);
    expect(isDeepFrozen(frozen)).toBe(true);
    for (const result of results) {
      expect(result).not.toBeNull();
      expect(isDeepFrozen(result)).toBe(true);
    }
    // The real schedule, deep-frozen already, passes through every edit too.
    expect(isDeepFrozen(S)).toBe(true);
    expect(() => {
      const cut = withTaskCard(S, 'factcheck', NOV_3, cutCard);
      cancelTaskChange(cut, 'factcheck', NOV_3);
      moveTaskChange(cut, 'factcheck', NOV_3, NOV_10);
      for (const task of CREDIT_TASKS) scheduledTaskChanges(S, task, NOW);
    }).not.toThrow();
    // The card passed in is copied, not frozen in place.
    const mine = { ...FC, maxChargeMicros: 320_000 };
    withTaskCard(S, 'factcheck', NOV_3, mine);
    expect(Object.isFrozen(mine)).toBe(false);
  });
});

describe('reading the schedule', () => {
  it('test_scheduled_task_changes', () => {
    for (const task of CREDIT_TASKS) expect(scheduledTaskChanges(S, task, NOW), task).toEqual([]);
    const head = withTaskCard(S2, 'classify', NOV_3, cheaperClassify);
    expect(scheduledTaskChanges(head, 'classify', NOW)).toEqual([
      { effectiveFrom: NOV_3, card: cheaperClassify, before: CLASSIFY },
    ]);
    // The 2026-11-03 entry does not change factcheck, so only 2026-12-10 is listed for it.
    expect(scheduledTaskChanges(head, 'factcheck', NOW)).toEqual([{ effectiveFrom: DEC_10, card: raisedCard, before: FC }]);
    expect(scheduledTaskChanges(head, 'perspectives', NOW)).toEqual([]);
    // Before 2026-10-18, its entry is the scheduled first card of factcheck and perspectives, not a classify change.
    const oct17 = new Date('2026-10-17T12:00:00Z');
    expect(scheduledTaskChanges(S, 'factcheck', oct17)).toEqual([{ effectiveFrom: OCT_18, card: FC, before: null }]);
    expect(scheduledTaskChanges(S, 'perspectives', oct17)).toEqual([{ effectiveFrom: OCT_18, card: PC, before: null }]);
    expect(scheduledTaskChanges(S, 'classify', oct17)).toEqual([]);
    // An entry at exactly `now` is in effect, not scheduled.
    expect(scheduledTaskChanges(S, 'factcheck', new Date(OCT_18))).toEqual([]);
  });

  it('test_card_change_kind_and_earliest_start', () => {
    expect(cardChangeKind(FC, raisedCard)).toBe('raise');
    expect(cardChangeKind(FC, { ...FC, referenceCostMicrosPer1000: 130_000_000 })).toBe('raise');
    expect(cardChangeKind(FC, { ...FC, maxChargeMicros: 500_000 })).toBe('raise');
    // One figure higher is a raise, whatever else is lower.
    expect(cardChangeKind(FC, { ...FC, multiplier: 2.5, maxChargeMicros: 350_000 })).toBe('raise');
    expect(cardChangeKind(FC, cutCard)).toBe('cut');
    expect(cardChangeKind(FC, { ...FC, multiplier: 1.5 })).toBe('cut');
    expect(cardChangeKind(FC, { ...FC, referenceModel: 'claude-opus-5-5' })).toBe('neutral');
    expect(cardChangeKind(CLASSIFY, { ...CLASSIFY, unit: 'post' })).toBe('neutral');
    expect(cardChangeKind(FC, { ...FC })).toBe('same');
    expect(cardChangeKind(null, FC)).toBe('first');

    expect(earliestStart('raise', NOW)).toBe(DEC_3);
    expect(earliestStart('raise', NOW, 45)).toBe('2026-12-18T00:00:00Z');
    for (const kind of ['first', 'same', 'cut', 'neutral'] as const) expect(earliestStart(kind, NOW), kind).toBe(NOV_3);

    // The kind and its earliest start agree with the rules: from that date the change passes, a day sooner it does not.
    for (const card of [raisedCard, { ...FC, maxChargeMicros: 500_000 }, cutCard, { ...FC, referenceModel: 'claude-opus-5-5' }]) {
      const from = earliestStart(cardChangeKind(FC, card), NOW);
      expect(priceScheduleChangeIssues(S, withTaskCard(S, 'factcheck', from, card), NOW)).toEqual([]);
      const sooner = new Date(Date.parse(from) - 86_400_000).toISOString().replace('.000Z', 'Z');
      expect(priceScheduleChangeIssues(S, withTaskCard(S, 'factcheck', sooner, card), NOW)).toHaveLength(1);
    }

    expect(sameTaskCard(undefined, null)).toBe(true);
    expect(sameTaskCard(FC, { ...FC })).toBe(true);
    expect(sameTaskCard(FC, null)).toBe(false);
    expect(sameTaskCard(undefined, FC)).toBe(false);
  });
});
