/**
 * The account page's Credits section, shown only when the server advertises billing: the balance and what it buys, the
 * promotional credit, the history in the server's order, and the links the server gives. Every figure comes from the
 * server's answer to `GET /v1/billing/account`; `fetch` is a fake server per test (support/fake-server.ts).
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import {
  ACCOUNT_DEVICES_PATH,
  CREDIT_ACCOUNT_PATH,
  CREDIT_PRICE_SCHEDULE,
  type CreditAccount,
  type CreditBalance,
  type CreditHistoryItem,
  type CreditPriceSchedule,
  type CreditPriceScheduleEntry,
  retailMicrosPer1000Posts,
  SERVER_INFO_PATH,
} from '@unalgorithm/protocol';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Account } from '../src/Account.tsx';
import { PASSKEY_LIST_PATH, SESSION_PATH } from '../src/api.ts';
import { Credits } from '../src/Credits.tsx';
import { type Answer, fakeServer, INFO, type Reply, SIGNED_IN, TOM } from './support/fake-server.ts';

const PAUSED = 'AI is paused while the balance is empty. Filters and results already saved keep working.';
const LOAD_FAILED = "Couldn't load your credits.";
const EXPIRES = '2027-01-11T15:00:00.000Z';
/** The fixed instant the price tests run at: no test reads a price from the real schedule at the real clock. */
const NOW = new Date('2026-10-14T12:00:00Z');
const PRICE_NOW = 'AI costs about $0.15 per 1,000 posts.';

/** A stub schedule: the launch card, then a raise to 2.5 from 15 November. */
const card = (multiplier: number) => ({ multiplier, referenceModel: 'claude-haiku-5-5', referenceCostMicrosPer1000: 73_000 });
const S: CreditPriceSchedule = [
  { effectiveFrom: '2026-10-01T00:00:00Z', cards: { classify: card(2) } },
  { effectiveFrom: '2026-11-15T00:00:00Z', cards: { classify: card(2.5) } },
];

/** Fakes `Date` (only) at `instant` for the rest of the test; `afterEach` restores the real clock. */
function clockAt(instant: Date) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(instant);
}

/** The starter credit as granted, less one day of AI: $0.97, all of it promotional. */
const BALANCE: CreditBalance = {
  v: 1,
  balanceMicros: 970_000,
  promoMicros: 970_000,
  purchasedMicros: 0,
  promoExpiresAt: EXPIRES,
  starter: 'active',
};

function account(balance: Partial<CreditBalance> = {}, rest: Partial<Omit<CreditAccount, 'balance'>> = {}): CreditAccount {
  return { v: 1, balance: { ...BALANCE, ...balance }, history: [], ...rest };
}

/** Opens the account page signed in on a server that advertises billing, with `reply` for the credits request. */
function openCredits(reply: Reply, { billing = true }: { billing?: boolean } = {}) {
  const server = fakeServer({
    session: TOM,
    info: { ...INFO, billing },
    routes: { [`GET ${CREDIT_ACCOUNT_PATH}`]: reply },
  });
  const user = setupUser();
  const view = render(<Account />);
  return { server, user, ...view };
}

/** The loaded Credits section, once the balance figure is on it. */
async function loadedCredits(): Promise<HTMLElement> {
  const section = await screen.findByRole('region', { name: 'Credits' });
  await within(section).findByText((_, el) => el?.classList.contains('ua-stat') ?? false);
  return section;
}

/** The balance figure (`ua-stat`), or null when none is shown. */
function figure(section: HTMLElement): string | null {
  return section.querySelector('.ua-stat')?.textContent ?? null;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.title = '';
});

describe('visibility', () => {
  it('test_credits_hidden_without_billing', async () => {
    const server = openCredits({ status: 200, body: account() }, { billing: false }).server;
    await screen.findByText(SIGNED_IN);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.count('GET', CREDIT_ACCOUNT_PATH)).toBe(0);
    // Only the Devices and Passkeys sections ask for theirs (account-devices.test.tsx).
    await waitFor(() =>
      expect(server.calls.map((c) => c.path)).toEqual([SERVER_INFO_PATH, SESSION_PATH, ACCOUNT_DEVICES_PATH, PASSKEY_LIST_PATH]),
    );
    expect(screen.queryByRole('heading', { name: 'Credits' })).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
    cleanup();

    // The same page on a server that advertises billing asks once and shows the section below the account row.
    const billed = openCredits({ status: 200, body: account() }).server;
    const section = await loadedCredits();
    expect(within(section).getByRole('heading', { level: 2, name: 'Credits' })).toBeTruthy();
    expect(billed.count('GET', CREDIT_ACCOUNT_PATH)).toBe(1);
    const row = screen.getByText(SIGNED_IN);
    expect(row.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('content', () => {
  it('test_credits_balance_and_starter', async () => {
    clockAt(NOW);
    // The starter credit alone, with its expiry.
    openCredits({ status: 200, body: account() });
    let section = await loadedCredits();
    expect(figure(section)).toBe('$0.97');
    expect(within(section).getByText('about 6,600 posts')).toBeTruthy();
    expect(within(section).getByText('Promotional credit: $0.97 left, first expiry Jan 11, 2027')).toBeTruthy();
    expect(within(section).queryByText(PAUSED)).toBeNull();
    cleanup();

    // The starter credit plus a $0.25 goodwill lot: both promotional, so the line never says "Starter credit:".
    openCredits({ status: 200, body: account({ balanceMicros: 1_220_000, promoMicros: 1_220_000 }) });
    section = await loadedCredits();
    expect(figure(section)).toBe('$1.22');
    expect(within(section).getByText('about 8,300 posts')).toBeTruthy();
    expect(within(section).getByText('Promotional credit: $1.22 left, first expiry Jan 11, 2027')).toBeTruthy();
    expect(within(section).queryByText(/^Starter credit:/)).toBeNull();
    expect(section.textContent).not.toContain('Starter credit:');
    cleanup();

    // Promotional credit that never expires (the public fixture's shape): no date, and never 1 January 1970.
    openCredits({ status: 200, body: account({ promoExpiresAt: null }) });
    section = await loadedCredits();
    expect(within(section).getByText('Promotional credit: $0.97 left')).toBeTruthy();
    expect(section.textContent).not.toContain('expiry');
    expect(section.textContent).not.toContain('1970');
  });

  it('test_credits_history_lines', async () => {
    // Deliberately oldest first: the page keeps the server's order and never sorts.
    const history: CreditHistoryItem[] = [
      { kind: 'grant', reason: 'starter-credit', amountMicros: 1_000_000, at: '2026-10-13T15:00:00.000Z' },
      { kind: 'usage', reason: 'classify', amountMicros: -60_000, at: '2026-10-14T00:00:00.000Z', posts: 412 },
      { kind: 'usage', reason: 'classify', amountMicros: -146, at: '2026-10-15T00:00:00.000Z', posts: 1 },
      { kind: 'adjustment', reason: 'promo-expired', amountMicros: -940_000, at: '2027-01-11T15:00:00.000Z' },
      { kind: 'adjustment', reason: 'goodwill', amountMicros: 250_000, at: '2027-01-12T09:30:00.000Z' },
      { kind: 'adjustment', reason: 'correction', amountMicros: -20_000, at: '2027-01-13T09:30:00.000Z' },
    ];
    openCredits({ status: 200, body: account({}, { history }) });
    const section = await loadedCredits();
    const group = within(section).getByRole('heading', { name: 'History' }).closest('section') as HTMLElement;
    const lines = [...group.querySelectorAll('.ua-row')].map((row) =>
      ['.ua-row-title', '.ua-row-subtitle', '.web-amount'].map((part) => row.querySelector(part)?.textContent),
    );
    expect(lines).toEqual([
      ['Starter credit', 'Oct 13, 2026', '+$1.00'],
      ['AI for 412 posts', 'Oct 14, 2026', '−$0.06'],
      ['AI for 1 post', 'Oct 15, 2026', '−<$0.01'],
      ['Promotional credit expired', 'Jan 11, 2027', '−$0.94'],
      ['Credit from support', 'Jan 12, 2027', '+$0.25'],
      ['Correction', 'Jan 13, 2027', '−$0.02'],
    ]);
    expect(within(section).queryByText('No credit activity yet.')).toBeNull();
    cleanup();

    openCredits({ status: 200, body: account() });
    expect(within(await loadedCredits()).getByText('No credit activity yet.')).toBeTruthy();
  });

  it('test_credits_history_titles_checks', async () => {
    const usage = (reason: 'factcheck' | 'perspectives', posts: number): CreditHistoryItem => ({
      kind: 'usage',
      reason,
      amountMicros: -240_000 * posts,
      at: '2026-11-02T00:00:00.000Z',
      posts,
    });
    const history = [usage('factcheck', 2), usage('factcheck', 1), usage('perspectives', 3), usage('perspectives', 1)];
    openCredits({ status: 200, body: account({}, { history }) });
    const section = await loadedCredits();
    const titles = [...section.querySelectorAll('.ua-row-title')].map((title) => title.textContent);
    expect(titles).toEqual([
      'Fact-check, 2 checks',
      'Fact-check, 1 check',
      'UnEcho Chamber, 3 comparisons',
      'UnEcho Chamber, 1 comparison',
    ]);
  });

  it('test_credits_money_history_lines', async () => {
    const line = (kind: CreditHistoryItem['kind'], reason: CreditHistoryItem['reason'], amountMicros: number) =>
      ({ kind, reason, amountMicros, at: '2026-11-02T10:00:00.000Z' }) as CreditHistoryItem;
    const history = [
      line('purchase', 'credit-pack', 10_000_000),
      line('refund', 'refund', -4_200_000),
      line('chargeback', 'chargeback', -5_000_000),
      line('chargeback', 'chargeback-reversed', 5_000_000),
      line('refund', 'test-mode-void', -5_000_000),
    ];
    openCredits({ status: 200, body: account({}, { history }) });
    const section = await loadedCredits();
    const lines = [...section.querySelectorAll('.ua-row')].map((row) =>
      ['.ua-row-title', '.web-amount'].map((part) => row.querySelector(part)?.textContent),
    );
    expect(lines).toEqual([
      ['Credit purchase', '+$10.00'],
      ['Refund', '−$4.20'],
      ['Chargeback', '−$5.00'],
      ['Chargeback reversed', '+$5.00'],
      ['Test credit removed', '−$5.00'],
    ]);
  });

  it('test_credits_auto_reload_history_line', async () => {
    const item = { kind: 'purchase', reason: 'auto-reload', amountMicros: 10_000_000, at: '2026-11-02T10:00:00.000Z' };
    openCredits({ status: 200, body: account({}, { history: [item as CreditHistoryItem] }) });
    const section = await loadedCredits();
    const lines = [...section.querySelectorAll('.ua-row')].map((row) =>
      ['.ua-row-title', '.web-amount'].map((part) => row.querySelector(part)?.textContent),
    );
    expect(lines).toEqual([['Auto-reload', '+$10.00']]);
  });

  it('test_credits_purchased_line', async () => {
    openCredits({ status: 200, body: account({ balanceMicros: 5_170_000, purchasedMicros: 4_200_000, promoMicros: 970_000 }) });
    let section = await loadedCredits();
    expect(within(section).getByText('Purchased credit: $4.20')).toBeTruthy();
    // Nothing about expiry: purchased credit never expires in the protocol.
    expect(within(section).getByText('Purchased credit: $4.20').textContent).not.toMatch(/expir/i);
    cleanup();

    openCredits({ status: 200, body: account() });
    section = await loadedCredits();
    expect(section.textContent).not.toContain('Purchased credit');
  });

  it('test_credits_refund_policy_link', async () => {
    openCredits({ status: 200, body: account() });
    let section = await loadedCredits();
    expect(within(section).queryByRole('link', { name: 'Refund policy' })).toBeNull();
    cleanup();

    const refundPolicyUrl = 'https://example.org/refunds';
    openCredits({ status: 200, body: account({}, { pricingUrl: 'https://example.org/credits', refundPolicyUrl }) });
    section = await loadedCredits();
    const refund = within(section).getByRole('link', { name: 'Refund policy' });
    expect(refund.getAttribute('href')).toBe(refundPolicyUrl);
    expect(refund.getAttribute('target')).toBe('_blank');
    expect(refund.getAttribute('rel')).toBe('noreferrer');
    // After "How credits work".
    const pricing = within(section).getByRole('link', { name: 'How credits work' });
    expect(pricing.compareDocumentPosition(refund) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('test_credits_empty_balance', async () => {
    openCredits({ status: 200, body: account({ balanceMicros: 0, promoMicros: 0, promoExpiresAt: null, starter: 'spent' }) });
    const section = await loadedCredits();
    expect(figure(section)).toBe('$0.00');
    expect(within(section).getByText(PAUSED)).toBeTruthy();
    // No estimate of posts (the price line is per 1,000 posts, not what this balance buys).
    expect(section.textContent).not.toMatch(/about [\d,]+ posts?\b/);
  });

  it('test_credits_starter_states', async () => {
    const states = [
      ['spent', 'Starter credit used.'],
      ['expired', 'Starter credit expired.'],
      ['unavailable', "Starter credit isn't available for this account."],
    ] as const;
    for (const [starter, sentence] of states) {
      openCredits({ status: 200, body: account({ balanceMicros: 0, promoMicros: 0, promoExpiresAt: null, starter }) });
      const section = await loadedCredits();
      expect(within(section).getByText(sentence)).toBeTruthy();
      // Nothing promotional is held, so there is no promotional line, and no reason is given.
      expect(section.textContent).not.toContain('Promotional credit:');
      for (const [, other] of states) if (other !== sentence) expect(section.textContent).not.toContain(other);
      cleanup();
    }

    // Promotional credit held after the starter credit is gone (a goodwill lot) is still reported, with its expiry.
    openCredits({ status: 200, body: account({ balanceMicros: 250_000, promoMicros: 250_000, starter: 'spent' }) });
    const section = await loadedCredits();
    expect(within(section).getByText('Promotional credit: $0.25 left, first expiry Jan 11, 2027')).toBeTruthy();
    expect(within(section).getByText('Starter credit used.')).toBeTruthy();
  });

  it('test_credits_links_from_server', async () => {
    openCredits({ status: 200, body: account() });
    let section = await loadedCredits();
    expect(within(section).getByText("Adding credit isn't available yet.")).toBeTruthy();
    expect(within(section).queryByRole('link', { name: 'Add credit' })).toBeNull();
    expect(within(section).queryByText('Any amount from $5 to $500.')).toBeNull();
    expect(within(section).queryByRole('link', { name: 'How credits work' })).toBeNull();
    cleanup();

    const pricingUrl = 'https://example.org/credits';
    openCredits({ status: 200, body: account({}, { addCreditPath: '/account/credit', pricingUrl }) });
    section = await loadedCredits();
    const add = within(section).getByRole('link', { name: 'Add credit' });
    expect(add.getAttribute('href')).toBe('/account/credit');
    // A page on this server: it opens in place.
    expect(add.getAttribute('target')).toBeNull();
    expect(within(section).queryByText("Adding credit isn't available yet.")).toBeNull();
    // Any amount within the rules, no packs.
    const range = within(section).getByText('Any amount from $5 to $500.');
    expect(add.compareDocumentPosition(range) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section.textContent).not.toMatch(/\bpacks?\b/i);
    const pricing = within(section).getByRole('link', { name: 'How credits work' });
    expect(pricing.getAttribute('href')).toBe(pricingUrl);
    expect(pricing.getAttribute('target')).toBe('_blank');
    expect(pricing.getAttribute('rel')).toBe('noreferrer');
  });
});

describe('auto-reload line', () => {
  const path = '/billing/auto-reload';
  const amounts = { amountMicros: 10_000_000, thresholdMicros: 1_000_000, monthlyLimitMicros: 25_000_000 };

  it('test_credits_auto_reload_states', async () => {
    const states = [
      [{ path, state: 'off' }, 'Auto-reload is off.', 'Set up auto-reload'],
      [
        { path, state: 'on', ...amounts },
        'Auto-reload: $10.00 when the balance is under $1.00, up to $25.00 a month.',
        'Change auto-reload',
      ],
      [
        { path, state: 'stopped', ...amounts },
        "Auto-reload is off: the last automatic payment didn't go through.",
        'Set up auto-reload again',
      ],
    ] as const;
    for (const [autoReload, sentence, label] of states) {
      openCredits({ status: 200, body: account({}, { addCreditPath: '/account/credit', autoReload }) });
      const section = await loadedCredits();
      expect(within(section).getByText(sentence)).toBeTruthy();
      const link = within(section).getByRole('link', { name: label });
      expect(link.getAttribute('href')).toBe(path);
      // A page on this server: it opens in place.
      expect(link.getAttribute('target')).toBeNull();
      // After "Add credit".
      const add = within(section).getByRole('link', { name: 'Add credit' });
      expect(add.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      for (const [, other, otherLabel] of states) {
        if (other !== sentence) expect(within(section).queryByText(other)).toBeNull();
        if (otherLabel !== label) expect(within(section).queryByRole('link', { name: otherLabel })).toBeNull();
      }
      cleanup();
    }
  });

  it('test_credits_no_auto_reload_without_summary', async () => {
    openCredits({ status: 200, body: account({}, { addCreditPath: '/account/credit' }) });
    const section = await loadedCredits();
    expect(section.textContent).not.toMatch(/auto-reload/i);
  });
});

describe('price', () => {
  const signedOut = () => {};
  const routes = { [`GET ${CREDIT_ACCOUNT_PATH}`]: { status: 200, body: account() } };

  it('test_credits_price_in_effect', async () => {
    clockAt(NOW);
    openCredits({ status: 200, body: account() });
    const section = await loadedCredits();
    expect(within(section).getByText(PRICE_NOW)).toBeTruthy();
    // From the real schedule, a From line exactly when a later entry changes the classify price per 1,000 posts.
    const nowPrice = retailMicrosPer1000Posts(NOW);
    const changes = CREDIT_PRICE_SCHEDULE.some(
      (e) => Date.parse(e.effectiveFrom) > NOW.getTime() && retailMicrosPer1000Posts(new Date(e.effectiveFrom)) !== nowPrice,
    );
    expect(within(section).queryByText(/^From /) !== null).toBe(changes);
    cleanup();

    // While loading, and after an error: no price.
    let answer: (reply: Answer) => void = () => {};
    const view = openCredits(
      () =>
        new Promise<Answer>((resolve) => {
          answer = resolve;
        }),
    );
    const loading = await screen.findByRole('region', { name: 'Credits' });
    await waitFor(() => expect(view.server.count('GET', CREDIT_ACCOUNT_PATH)).toBe(1));
    expect(loading.textContent).not.toContain('AI costs');
    answer({ status: 500, body: { code: 'unknown', message: 'Something went wrong.' } });
    expect((await within(loading).findByRole('alert')).textContent).toContain(LOAD_FAILED);
    expect(screen.queryByText(/AI costs/)).toBeNull();
  });

  it('test_credits_scheduled_change', async () => {
    clockAt(NOW);
    fakeServer({ session: TOM, info: { ...INFO, billing: true }, routes });
    render(<Credits schedule={S} onSignedOut={signedOut} />);
    let section = await loadedCredits();
    expect(within(section).getByText(PRICE_NOW)).toBeTruthy();
    expect(within(section).getByText('From Nov 15, 2026 (UTC): about $0.18 per 1,000 posts.')).toBeTruthy();
    expect(within(section).getByText('about 6,600 posts')).toBeTruthy();
    cleanup();

    // On the date the new card is the price in effect, and nothing further is scheduled.
    vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
    render(<Credits schedule={S} onSignedOut={signedOut} />);
    section = await loadedCredits();
    expect(within(section).getByText('AI costs about $0.18 per 1,000 posts.')).toBeTruthy();
    expect(within(section).getByText('about 5,300 posts')).toBeTruthy();
    expect(within(section).queryByText(/^From /)).toBeNull();
  });

  it('test_credits_no_next_line_when_classify_price_unchanged', async () => {
    const shows = async (schedule: CreditPriceSchedule | undefined, at: Date) => {
      cleanup();
      clockAt(at);
      fakeServer({ session: TOM, info: { ...INFO, billing: true }, routes });
      render(<Credits schedule={schedule} onSignedOut={signedOut} />);
      return within(await loadedCredits()).queryByText(/^From /)?.textContent ?? null;
    };
    const OCT_20 = new Date('2026-10-20T12:00:00Z');
    // The real schedule: the 2026-11-01 entry only adds perspectives, so the account page names no change.
    expect(await shows(undefined, OCT_20)).toBeNull();
    // A next entry that changes the classify multiplier still shows.
    expect(await shows(S, OCT_20)).toBe('From Nov 15, 2026 (UTC): about $0.18 per 1,000 posts.');
    // A perspectives-only entry never hides a later classify change behind it.
    const perspectives: CreditPriceScheduleEntry['cards']['perspectives'] = {
      multiplier: 2,
      referenceModel: 'claude-sonnet-5-5',
      referenceCostMicrosPer1000: 135_000_000,
      unit: 'comparison',
      maxChargeMicros: 500_000,
    };
    const added: CreditPriceSchedule = [
      { effectiveFrom: '2026-10-01T00:00:00Z', cards: { classify: card(2) } },
      { effectiveFrom: '2026-11-01T00:00:00Z', cards: { classify: card(2), perspectives } },
      { effectiveFrom: '2026-12-01T00:00:00Z', cards: { classify: card(2.5), perspectives } },
    ];
    expect(await shows(added, OCT_20)).toBe('From Dec 1, 2026 (UTC): about $0.18 per 1,000 posts.');
  });
});

describe('errors', () => {
  it('test_credits_loading_error_and_retry', async () => {
    // While the answer is out: busy, and no figure.
    let answer: (reply: Answer) => void = () => {};
    let view = openCredits(
      () =>
        new Promise<Answer>((resolve) => {
          answer = resolve;
        }),
    );
    let section = await screen.findByRole('region', { name: 'Credits' });
    // The section's effect asks for the credits after the section is on the page, which on a busy machine can be after
    // `findByRole` returns: answer once the request is out (an answer before it would go nowhere).
    await waitFor(() => expect(view.server.count('GET', CREDIT_ACCOUNT_PATH)).toBe(1));
    expect(section.getAttribute('aria-busy')).toBe('true');
    expect(figure(section)).toBeNull();
    expect(within(section).queryByRole('alert')).toBeNull();
    answer({ status: 200, body: account() });
    section = await loadedCredits();
    expect(figure(section)).toBe('$0.97');
    expect(section.hasAttribute('aria-busy')).toBe(false);
    cleanup();

    // A failure, then an answer: "Try again" asks again.
    for (const failure of [{ status: 500, body: { code: 'unknown', message: 'Something went wrong.' } }, 'offline'] as const) {
      let tries = 0;
      view = openCredits(() => {
        tries += 1;
        if (tries > 1) return { status: 200, body: account() };
        if (failure === 'offline') throw new TypeError('Failed to fetch');
        return failure;
      });
      section = await screen.findByRole('region', { name: 'Credits' });
      expect((await within(section).findByRole('alert')).textContent).toContain(LOAD_FAILED);
      expect(figure(section)).toBeNull();
      expect(section.hasAttribute('aria-busy')).toBe(false);
      // The rest of the page stays as it was.
      expect(screen.getByText(SIGNED_IN)).toBeTruthy();
      await view.user.click(within(section).getByRole('button', { name: 'Try again' }));
      expect(figure(await loadedCredits())).toBe('$0.97');
      expect(screen.queryByText(LOAD_FAILED)).toBeNull();
      expect(view.server.count('GET', CREDIT_ACCOUNT_PATH)).toBe(2);
      cleanup();
    }

    // The session is gone (401): the page returns to the sign-in step.
    view = openCredits({ status: 401, body: { code: 'auth-required', message: 'Sign in again.' } });
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(screen.getByText('Sign in to see your account.')).toBeTruthy();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Credits' })).toBeNull();
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
    expect(view.server.count('GET', CREDIT_ACCOUNT_PATH)).toBe(1);
  });

  it('test_credits_rejects_invalid_body', async () => {
    const invalid = [
      // The parts do not add up to the balance.
      account({ balanceMicros: 970_000, promoMicros: 900_000, purchasedMicros: 0 }),
      // A usage line without its posts.
      account({}, { history: [{ kind: 'usage', reason: 'classify', amountMicros: -60_000, at: EXPIRES }] }),
      // An address elsewhere for adding credit.
      account({}, { addCreditPath: '//elsewhere.example/credit' }),
    ];
    for (const body of invalid) {
      openCredits({ status: 200, body });
      const section = await screen.findByRole('region', { name: 'Credits' });
      expect((await within(section).findByRole('alert')).textContent).toContain(LOAD_FAILED);
      expect(figure(section)).toBeNull();
      expect(section.textContent).not.toMatch(/\$\d/);
      expect(within(section).queryByRole('link')).toBeNull();
      cleanup();
    }
  });
});
