/**
 * The rest of the Pricing page (PA-06, decisions PD4–PD6, PD9, PD14): the starter credit, buying credit and auto-reload
 * caps, each with its figures now, an inline form that says when its change applies and checks it with the server's
 * own rules as the admin types, and the append-only history of every price change with when and which admin. `fetch`
 * is PA-05's fake server: its Pricing routes start from `DEFAULT_PRICE_BOOK` at `PRICES_NOW` (2026-11-02T12:00:00Z) and
 * check a change with the same functions as the server.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import {
  ADMIN_PRICES_PATH,
  type CreditPriceCard,
  DEFAULT_PRICE_BOOK,
  type PriceChange,
  priceCardsAt,
  type ServerInfo,
} from '@unalgorithm/protocol';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { priceChangeLine } from '../src/AdminPriceSettings.tsx';
import { AdminPrices } from '../src/AdminPrices.tsx';
import { type Call, fakeServer, INFO, PRICES_CHANGED, SESSION_GONE, TOM } from './support/fake-server.ts';

const STARTER_NOW = 'New accounts get $1.00 of starter credit, for 90 days.';
const PURCHASE_NOW = 'Any amount from $5 to $500. Quick picks $5, $10 and $25, with $10 preselected.';
const AUTO_RELOAD_NOW = 'Auto-reload: at most $1,000 a month and 2 top-ups a day.';
const STARTER_APPLIES = 'Applies to accounts created from now on. Accounts made earlier keep the amount they were offered.';
const PURCHASE_APPLIES =
  'Applies at once to new purchases. A payment already started still adds what was paid, and auto-reload keeps the ' +
  'amount each person agreed to.';
const AUTO_RELOAD_APPLIES =
  'Lowering a cap applies at once to everyone with auto-reload on. Raising one applies only to people who turn ' +
  'auto-reload on, or change it, from now on.';
const STARTER_RANGE = 'The starter credit must be from $0.10 to $10.00, in whole cents.';
const PICKS_RULE = 'Quick picks: 1 to 4 whole-dollar amounts, smallest first, from the least to the most.';
const PURCHASE_RANGE = 'Amounts must be whole dollars from $1 to $1,000.';
const MONTHLY_RULE = 'The monthly limit must be whole dollars from the least amount people can buy to $5,000.';
const CHANGED = 'The prices changed since you opened this page.';
const SIGNED_OUT = 'You were signed out. Sign in again.';
const SEED_LINE = 'Stored the prices this server shipped with';
const EMPTY_HISTORY = 'No changes yet. These are the prices this server shipped with.';
/** `PRICES_NOW`, as the history dates a change. */
const SAVED_AT = 'Nov 2, 2026, 12:00 UTC';

/** A billing server: what the tests open the page on. */
const BILLING_INFO: ServerInfo = { ...INFO, billing: true };

/** The default book's cards in effect at the page's clock (its 2026-10-18 entry). */
const DEFAULT_CARDS = priceCardsAt(new Date('2026-11-02T12:00:00Z'), DEFAULT_PRICE_BOOK.schedule).cards;
const CLASSIFY = DEFAULT_CARDS.classify;
const FACTCHECK = DEFAULT_CARDS.factcheck as CreditPriceCard;
const PERSPECTIVES = DEFAULT_CARDS.perspectives as CreditPriceCard;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.title = '';
});

/** Opens the page; by default TOM is signed in as an admin of a billing server with the default book. */
function openPrices(options: Parameters<typeof fakeServer>[0] = {}) {
  const server = fakeServer({ session: TOM, role: 'admin', info: BILLING_INFO, ...options });
  const user = setupUser();
  render(<AdminPrices />);
  return { server, user };
}

/** The changes the page sent to the Pricing route, in order. */
function changes(server: ReturnType<typeof fakeServer>): Call[] {
  return server.posts().filter((c) => c.path === ADMIN_PRICES_PATH);
}

/** A part of the page, by its heading. */
function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

/** A form control by its label. */
function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function save(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
}

/** Replaces what a text field holds. */
async function retype(user: ReturnType<typeof setupUser>, label: string, text: string) {
  await user.clear(field(label));
  await user.type(field(label), text);
}

/** The options a select offers, as shown. */
function options(label: string): string[] {
  return [...(field(label) as unknown as HTMLSelectElement).options].map((o) => o.textContent ?? '');
}

/** Each history row's line and its "when · by" subtitle, top to bottom. */
function historyRows(): [string | null | undefined, string | null | undefined][] {
  return [...region('History').querySelectorAll('.ua-row')].map((row) => [
    row.querySelector('.ua-row-title')?.textContent,
    row.querySelector('.ua-row-subtitle')?.textContent,
  ]);
}

/** Waits for the prices, then opens a section's form with its "Edit" button. */
async function openSection(user: ReturnType<typeof setupUser>, name: string, edit: string) {
  await screen.findByRole('region', { name });
  await user.click(within(region(name)).getByRole('button', { name: edit }));
  expect(within(region(name)).getByRole('form')).toBeTruthy();
}

/** Lets pending effects and answers settle, for a test that checks something did not happen. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const EDIT_STARTER = 'Edit the starter credit';
const EDIT_PURCHASE = 'Edit the buying credit amounts';
const EDIT_AUTO_RELOAD = 'Edit the auto-reload caps';

describe('sections', () => {
  it('test_price_settings_show_values_and_when_they_apply', async () => {
    const { server, user } = openPrices();
    expect(await screen.findByText(STARTER_NOW)).toBeTruthy();
    expect(within(region('Starter credit')).getByText(STARTER_NOW)).toBeTruthy();
    expect(within(region('Buying credit')).getByText(PURCHASE_NOW)).toBeTruthy();
    expect(within(region('Auto-reload')).getByText(AUTO_RELOAD_NOW)).toBeTruthy();
    // The sections come after the task prices, then the history; each is a part of the page with its own heading.
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Task prices',
      'Starter credit',
      'Buying credit',
      'Auto-reload',
      'History',
    ]);
    // No "applies" line until a form is open.
    for (const line of [STARTER_APPLIES, PURCHASE_APPLIES, AUTO_RELOAD_APPLIES]) expect(screen.queryByText(line)).toBeNull();

    // Starter credit: filled with the amount now; nothing changed yet, so nothing to save.
    await openSection(user, 'Starter credit', EDIT_STARTER);
    expect(within(region('Starter credit')).getByText(STARTER_APPLIES)).toBeTruthy();
    expect(field('Amount').value).toBe('1.00');
    expect(save().disabled).toBe(true);
    // One form at a time: every other Edit and task button waits.
    expect((screen.getByRole('button', { name: EDIT_PURCHASE }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: EDIT_AUTO_RELOAD }) as HTMLButtonElement).disabled).toBe(true);
    for (const button of screen.getAllByRole('button', { name: 'Change the price' })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(STARTER_APPLIES)).toBeNull();
    expect(screen.queryByLabelText('Amount')).toBeNull();

    // Buying credit: least, most, the quick picks in one field, and the preselected one among them.
    await openSection(user, 'Buying credit', EDIT_PURCHASE);
    expect(within(region('Buying credit')).getByText(PURCHASE_APPLIES)).toBeTruthy();
    expect(field('Least').value).toBe('5');
    expect(field('Most').value).toBe('500');
    expect(field('Quick picks').value).toBe('5, 10, 25');
    expect(options('Preselected')).toEqual(['$5', '$10', '$25']);
    expect(field('Preselected').value).toBe('10000000');
    expect(save().disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(PURCHASE_APPLIES)).toBeNull();

    // Auto-reload: the most a month, and top-ups a day from 1 to 4.
    await openSection(user, 'Auto-reload', EDIT_AUTO_RELOAD);
    expect(within(region('Auto-reload')).getByText(AUTO_RELOAD_APPLIES)).toBeTruthy();
    expect(field('Most a month').value).toBe('1000');
    expect(options('Top-ups a day')).toEqual(['1', '2', '3', '4']);
    expect(field('Top-ups a day').value).toBe('2');
    expect(save().disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(AUTO_RELOAD_APPLIES)).toBeNull();

    await settle();
    expect(changes(server)).toEqual([]);
  });

  it('test_starter_credit_save_and_bounds', async () => {
    const { server, user } = openPrices();
    await openSection(user, 'Starter credit', EDIT_STARTER);

    // Below $0.10 or above $10.00: the rule's own words, and no saving.
    for (const text of ['0.05', '10.01', '1.005']) {
      await retype(user, 'Amount', text);
      expect(screen.getByText(STARTER_RANGE), text).toBeTruthy();
      expect(save().disabled, text).toBe(true);
      await user.click(save());
    }
    // Not an amount at all: the field says so.
    await retype(user, 'Amount', 'two');
    expect(screen.getByText('Enter an amount in dollars, like 1.00.')).toBeTruthy();
    expect(save().disabled).toBe(true);
    await settle();
    expect(changes(server)).toEqual([]);

    await retype(user, 'Amount', '2.00');
    expect(screen.queryByText(STARTER_RANGE)).toBeNull();
    expect(save().disabled).toBe(false);
    await user.click(save());
    expect(await screen.findByText('New accounts get $2.00 of starter credit, for 90 days.')).toBeTruthy();
    expect(changes(server)).toEqual([
      {
        method: 'POST',
        path: ADMIN_PRICES_PATH,
        body: { action: 'starter', baseVersion: '0', amountMicros: 2_000_000 },
      },
    ]);
    // The page loaded again: the form closed, and the history has the seed and the change.
    expect(server.count('GET', ADMIN_PRICES_PATH)).toBe(2);
    expect(screen.queryByLabelText('Amount')).toBeNull();
    expect(historyRows()).toEqual([
      ['Starter credit: $1.00 → $2.00', `${SAVED_AT} · by ${TOM}`],
      [SEED_LINE, `${SAVED_AT} · by ${TOM}`],
    ]);
  });

  it('test_buying_credit_save_and_rules', async () => {
    const { server, user } = openPrices();
    await openSection(user, 'Buying credit', EDIT_PURCHASE);

    // Quick picks out of order, or more than four: the rule's own words.
    for (const picks of ['25, 10', '5, 10, 25, 50, 100']) {
      await retype(user, 'Quick picks', picks);
      expect(screen.getByText(PICKS_RULE), picks).toBeTruthy();
      expect(save().disabled, picks).toBe(true);
    }
    // Not a list of whole dollars: the field says so.
    await retype(user, 'Quick picks', '5, 10.50');
    expect(screen.getByText('Enter whole dollars separated by commas, like 5, 10, 25.')).toBeTruthy();
    expect(save().disabled).toBe(true);
    // Picks without the preselected amount: one must be picked again.
    await retype(user, 'Quick picks', '25, 50');
    expect(options('Preselected')).toEqual(['Pick one', '$25', '$50']);
    expect(screen.getByText('Pick the preselected amount.')).toBeTruthy();
    expect(save().disabled).toBe(true);
    await retype(user, 'Quick picks', '5, 10, 25');
    expect(field('Preselected').value).toBe('10000000');
    expect(screen.queryByText(PICKS_RULE)).toBeNull();

    // A most above $1,000: the bounds.
    await retype(user, 'Most', '1001');
    expect(screen.getByText(PURCHASE_RANGE)).toBeTruthy();
    expect(save().disabled).toBe(true);
    await retype(user, 'Most', 'lots');
    expect(screen.getByText('Enter whole dollars, like 10.')).toBeTruthy();
    expect(save().disabled).toBe(true);
    await settle();
    expect(changes(server)).toEqual([]);

    await retype(user, 'Least', '10');
    await retype(user, 'Most', '1000');
    await retype(user, 'Quick picks', '10, 25, 100');
    expect(options('Preselected')).toEqual(['$10', '$25', '$100']);
    await user.selectOptions(field('Preselected'), '$25');
    expect(screen.queryByText(PURCHASE_RANGE)).toBeNull();
    expect(save().disabled).toBe(false);
    await user.click(save());
    expect(
      await screen.findByText('Any amount from $10 to $1,000. Quick picks $10, $25 and $100, with $25 preselected.'),
    ).toBeTruthy();
    expect(changes(server)).toEqual([
      {
        method: 'POST',
        path: ADMIN_PRICES_PATH,
        body: {
          action: 'purchase',
          baseVersion: '0',
          purchase: {
            minMicros: 10_000_000,
            maxMicros: 1_000_000_000,
            presetsMicros: [10_000_000, 25_000_000, 100_000_000],
            defaultMicros: 25_000_000,
          },
        },
      },
    ]);
    expect(screen.queryByLabelText('Quick picks')).toBeNull();
    expect(historyRows()[0]).toEqual([
      'Buying credit: least $5 → $10; most $500 → $1,000; quick picks $5, $10, $25 → $10, $25, $100; preselected $10 → $25',
      `${SAVED_AT} · by ${TOM}`,
    ]);
  });

  it('test_auto_reload_caps_save_and_rules', async () => {
    const { server, user } = openPrices();
    await openSection(user, 'Auto-reload', EDIT_AUTO_RELOAD);

    // Under the $5 least purchase, or above $5,000: the rule's own words.
    for (const text of ['3', '5001']) {
      await retype(user, 'Most a month', text);
      expect(screen.getByText(MONTHLY_RULE), text).toBeTruthy();
      expect(save().disabled, text).toBe(true);
    }
    await retype(user, 'Most a month', '1,000');
    expect(screen.getByText('Enter whole dollars, like 10.')).toBeTruthy();
    expect(save().disabled).toBe(true);
    await settle();
    expect(changes(server)).toEqual([]);

    await retype(user, 'Most a month', '500');
    await user.selectOptions(field('Top-ups a day'), '1');
    expect(screen.queryByText(MONTHLY_RULE)).toBeNull();
    expect(save().disabled).toBe(false);
    await user.click(save());
    expect(await screen.findByText('Auto-reload: at most $500 a month and 1 top-up a day.')).toBeTruthy();
    expect(changes(server)).toEqual([
      {
        method: 'POST',
        path: ADMIN_PRICES_PATH,
        body: { action: 'auto-reload', baseVersion: '0', autoReload: { monthlyLimitMaxMicros: 500_000_000, perDay: 1 } },
      },
    ]);
    expect(screen.queryByLabelText('Most a month')).toBeNull();
    expect(historyRows()[0]).toEqual([
      'Auto-reload: at most $1,000 → $500 a month; 2 → 1 top-ups a day',
      `${SAVED_AT} · by ${TOM}`,
    ]);
  });

  it('test_price_settings_refusals', async () => {
    // 409 on each section's save: said in that section, with "Reload", which asks for the prices again.
    let { server, user } = openPrices({ routes: { [`POST ${ADMIN_PRICES_PATH}`]: PRICES_CHANGED } });
    const edits: [string, string, () => Promise<void>][] = [
      ['Starter credit', EDIT_STARTER, () => retype(user, 'Amount', '2')],
      ['Buying credit', EDIT_PURCHASE, () => retype(user, 'Most', '600')],
      ['Auto-reload', EDIT_AUTO_RELOAD, () => user.selectOptions(field('Top-ups a day'), '1')],
    ];
    for (const [name, edit, change] of edits) {
      await openSection(user, name, edit);
      const gets = server.count('GET', ADMIN_PRICES_PATH);
      await change();
      await user.click(save());
      expect(await within(region(name)).findByText(CHANGED), name).toBeTruthy();
      expect(screen.queryByText(PRICES_CHANGED.body.message)).toBeNull();
      // The form stays open, as typed.
      expect(within(region(name)).getByRole('form')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Reload' }));
      await waitFor(() => expect(screen.queryByText(CHANGED)).toBeNull());
      expect(server.count('GET', ADMIN_PRICES_PATH)).toBe(gets + 1);
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
    }
    expect(changes(server)).toHaveLength(3);
    cleanup();

    // 400: the server's message, in a danger banner; the form stays as typed.
    const message = 'The starter credit must be from $0.10 to $10.00, in whole cents.';
    ({ server, user } = openPrices({
      routes: { [`POST ${ADMIN_PRICES_PATH}`]: { status: 400, body: { code: 'bad-request', message } } },
    }));
    await openSection(user, 'Starter credit', EDIT_STARTER);
    await retype(user, 'Amount', '3.50');
    await user.click(save());
    const refused = await within(region('Starter credit')).findByText(message);
    expect(refused.closest('.ua-banner')?.className).toContain('ua-banner--danger');
    expect(field('Amount').value).toBe('3.50');
    cleanup();

    // 401: back to the sign-in, saying so.
    ({ server, user } = openPrices({ routes: { [`POST ${ADMIN_PRICES_PATH}`]: SESSION_GONE } }));
    await openSection(user, 'Auto-reload', EDIT_AUTO_RELOAD);
    await retype(user, 'Most a month', '800');
    await user.click(save());
    expect(await screen.findByText(SIGNED_OUT)).toBeTruthy();
    expect(screen.queryByText(AUTO_RELOAD_NOW)).toBeNull();
  });
});

describe('history', () => {
  /** One stored change: by TOM on Nov 2, 2026 unless given. */
  const change = (seq: number, fields: Partial<PriceChange>): PriceChange => ({
    seq,
    at: '2026-11-02T12:00:00.000Z',
    action: 'seed',
    task: null,
    effectiveFrom: null,
    movedTo: null,
    before: null,
    after: null,
    by: TOM,
    ...fields,
  });
  const RAISE = { ...FACTCHECK, multiplier: 2.5, maxChargeMicros: 500_000 };
  const HISTORY: PriceChange[] = [
    change(1, { at: '2026-10-20T09:05:00.000Z' }),
    change(2, {
      at: '2026-10-21T15:30:00.000Z',
      action: 'schedule',
      task: 'factcheck',
      effectiveFrom: '2026-11-03T00:00:00Z',
      before: FACTCHECK,
      after: { ...FACTCHECK, maxChargeMicros: 300_000 },
    }),
    change(3, {
      action: 'schedule',
      task: 'perspectives',
      effectiveFrom: '2026-12-03T00:00:00Z',
      before: null,
      after: PERSPECTIVES,
    }),
    change(4, { action: 'schedule', task: 'factcheck', effectiveFrom: '2026-12-03T00:00:00Z', before: FACTCHECK, after: RAISE }),
    change(5, {
      action: 'move',
      task: 'factcheck',
      effectiveFrom: '2026-12-03T00:00:00Z',
      movedTo: '2026-12-10T00:00:00Z',
      before: RAISE,
      after: RAISE,
    }),
    change(6, { action: 'cancel', task: 'factcheck', effectiveFrom: '2026-12-10T00:00:00Z', before: RAISE, after: FACTCHECK }),
    change(7, { action: 'starter', before: 1_000_000, after: 2_000_000, by: null }),
    change(8, {
      action: 'purchase',
      before: DEFAULT_PRICE_BOOK.purchase,
      after: {
        minMicros: 10_000_000,
        maxMicros: 500_000_000,
        presetsMicros: [10_000_000, 25_000_000, 100_000_000],
        defaultMicros: 25_000_000,
      },
    }),
    change(9, {
      at: '2026-11-02T23:59:00.000Z',
      action: 'auto-reload',
      before: DEFAULT_PRICE_BOOK.autoReload,
      after: { monthlyLimitMaxMicros: 500_000_000, perDay: 1 },
    }),
  ];

  it('test_price_history_lines', async () => {
    // Listed newest first, though given oldest first here, each with its time (UTC) and admin.
    openPrices({ priceVersion: '9', priceChanges: HISTORY });
    await screen.findByRole('region', { name: 'History' });
    const by = `${SAVED_AT} · by ${TOM}`;
    expect(historyRows()).toEqual([
      ['Auto-reload: at most $1,000 → $500 a month; 2 → 1 top-ups a day', `Nov 2, 2026, 23:59 UTC · by ${TOM}`],
      ['Buying credit: least $5 → $10; quick picks $5, $10, $25 → $10, $25, $100; preselected $10 → $25', by],
      ['Starter credit: $1.00 → $2.00', `${SAVED_AT} · by a deleted account`],
      ['Cancelled the Fact-check change from Dec 10, 2026', by],
      ['Moved the Fact-check change from Dec 3, 2026 to Dec 10, 2026', by],
      ['Fact-check from Dec 3, 2026: multiplier 2× → 2.5×; at most $0.40 → $0.50', by],
      ['UnEcho Chamber priced from Dec 3, 2026: 2× our AI cost, at most $0.50 for one comparison', by],
      ['Fact-check from Nov 3, 2026: at most $0.40 → $0.30', `Oct 21, 2026, 15:30 UTC · by ${TOM}`],
      [SEED_LINE, `Oct 20, 2026, 09:05 UTC · by ${TOM}`],
    ]);
    // No id of any kind: no task or model id, no sequence number, no raw amount.
    const text = region('History').textContent ?? '';
    for (const id of ['factcheck', 'perspectives', 'claude-', 'Micros', '000000']) expect(text, id).not.toContain(id);

    // Every part that differs, in order: multiplier, reference model, our cost (per 1,000 posts for classify), at most.
    expect(
      priceChangeLine(
        change(10, {
          action: 'schedule',
          task: 'classify',
          effectiveFrom: '2026-12-03T00:00:00Z',
          before: CLASSIFY,
          after: { ...CLASSIFY, multiplier: 3, referenceModel: 'claude-sonnet-5-5', referenceCostMicrosPer1000: 80_000 },
        }),
      ),
    ).toBe(
      'Classifying posts from Dec 3, 2026: multiplier 2× → 3×; reference model Claude Haiku 5.5 → Claude Sonnet 5.5; ' +
        'our cost $0.073 → $0.08 per 1,000 posts',
    );
    expect(
      priceChangeLine(
        change(11, {
          action: 'schedule',
          task: 'factcheck',
          effectiveFrom: '2026-12-03T00:00:00Z',
          before: FACTCHECK,
          after: { ...FACTCHECK, referenceCostMicrosPer1000: 100_000_000 },
        }),
      ),
    ).toBe('Fact-check from Dec 3, 2026: our cost $0.12 → $0.10 per check');
    expect(
      priceChangeLine(
        change(12, {
          action: 'auto-reload',
          before: DEFAULT_PRICE_BOOK.autoReload,
          after: { ...DEFAULT_PRICE_BOOK.autoReload, perDay: 3 },
        }),
      ),
    ).toBe('Auto-reload: 2 → 3 top-ups a day');
  });

  it('test_price_history_empty', async () => {
    openPrices();
    await screen.findByRole('region', { name: 'History' });
    expect(within(region('History')).getByText(EMPTY_HISTORY)).toBeTruthy();
    expect(historyRows()).toEqual([[EMPTY_HISTORY, undefined]]);
  });
});
