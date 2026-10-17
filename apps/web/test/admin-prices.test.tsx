/**
 * The Pricing page at `/admin/prices` (PA-05, decisions PD3, PD7, PD12, PD14): an admin sees each task's price in effect
 * and its scheduled changes, with what people are shown for each, schedules a change from a date, and cancels or moves a
 * scheduled one, through PA-03's routes. `fetch` is the shared fake server, whose Pricing routes keep a book (the code
 * defaults unless a test passes its own), a version and a history, answer with the server's clock at `PRICES_NOW`
 * (2026-11-02T12:00:00Z, the 2026-10-18 prices in effect) and check a change with the server's own functions.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  ADMIN_PRICES_PAGE_PATH,
  ADMIN_PRICES_PATH,
  DEFAULT_PRICE_BOOK,
  EMAIL_OTP_METHOD,
  GOOGLE_METHOD,
  type PriceBook,
  priceCardsAt,
  SERVER_INFO_PATH,
  type ServerInfo,
  withTaskCard,
} from '@unalgorithm/protocol';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Admin } from '../src/Admin.tsx';
import { AdminPrices } from '../src/AdminPrices.tsx';
import { SOCIAL_SIGN_IN_PATH } from '../src/api.ts';
import { dollarsInput, fromUtcDayInput, parseDollars, parseMultiplier, utcDayInput } from '../src/money.ts';
import {
  type Call,
  fakeServer,
  GOOGLE_URL,
  INFO,
  PRICE_CHANGE_GONE,
  PRICES_CHANGED,
  SESSION_GONE,
  TOM,
} from './support/fake-server.ts';

const SIGN_IN_INTRO = 'Sign in to manage this server.';
const NOT_ADMIN = "This account isn't an admin of this server.";
const UNREACHABLE = "Couldn't reach the server. Try again.";
const SIGNED_OUT = 'You were signed out. Sign in again.';
const INTRO =
  'What people pay on this server. A price change starts at 00:00 UTC on the day you pick. Prices in effect never ' +
  "change: a raise needs 30 days' notice, and a cut can start tomorrow.";
const NO_BILLING = "This server doesn't charge for AI, so these prices aren't used until a billing module is loaded.";
const CHANGED = 'The prices changed since you opened this page.';
const GONE = 'That scheduled change is no longer on the list.';
const CUT_LINE = "This is a cut: it can start tomorrow. Once its date is less than 30 days away, it can't be cancelled.";
const CUT_QUESTION = "Save this cut? Once its date is less than 30 days away, it can't be cancelled.";
const RAISE_LINE = 'This is a raise: it can start on Dec 3, 2026 or later.';
const RAISE_TOO_SOON = "This raises the price of Fact-check, so it needs 30 days' notice. The earliest date is Dec 3, 2026.";
const ENTER_AMOUNT = 'Enter an amount in dollars, like 0.12.';
const ENTER_MULTIPLIER = 'Enter a multiplier, like 2 or 1.5.';

/** A billing server: what most tests open the page on. */
const BILLING_INFO: ServerInfo = { ...INFO, billing: true };

/** The task's card in the default book's 2026-10-18 entry (in effect at the page's clock). */
const DEFAULT_CARDS = priceCardsAt(new Date('2026-11-02T12:00:00Z'), DEFAULT_PRICE_BOOK.schedule).cards;
const FACTCHECK = DEFAULT_CARDS.factcheck as NonNullable<typeof DEFAULT_CARDS.factcheck>;

/** The default book with Fact-check at 2.5× from Dec 3, 2026: a raise with its 30 days' notice, saved as version 7. */
const RAISED: PriceBook = {
  ...DEFAULT_PRICE_BOOK,
  schedule: withTaskCard(DEFAULT_PRICE_BOOK.schedule, 'factcheck', '2026-12-03T00:00:00Z', { ...FACTCHECK, multiplier: 2.5 }),
};

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
  const view = render(<AdminPrices />);
  return { server, user, view };
}

/** The changes the page sent to the Pricing route, in order. */
function changes(server: ReturnType<typeof fakeServer>): Call[] {
  return server.posts().filter((c) => c.path === ADMIN_PRICES_PATH);
}

/** A task's group, by its heading. */
function group(name: string): HTMLElement {
  const found = screen.getByRole('heading', { level: 3, name }).closest('section');
  if (!found) throw new Error(`No group ${name}.`);
  return found;
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

/** Picks a day in a date field, as the browser's date picker does. */
function pickDay(label: string, day: string) {
  fireEvent.change(field(label), { target: { value: day } });
}

/** Waits for the prices, then opens the task's form. */
async function openForm(user: ReturnType<typeof setupUser>, name: string) {
  await screen.findByRole('heading', { level: 3, name });
  await user.click(within(group(name)).getByRole('button', { name: /^(Change the price|Set its first price)$/ }));
  expect(field('Multiplier')).toBeTruthy();
}

/** Lets pending effects and answers settle, for a test that checks something did not happen. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('access', () => {
  it('test_admin_prices_loading_unreachable_signed_out_and_not_admin', async () => {
    // Loading: busy. The server unreachable: said, and "Try again" loads the page again.
    let tries = 0;
    let { server, user, view } = openPrices({
      routes: {
        [`GET ${SERVER_INFO_PATH}`]: () => {
          tries += 1;
          if (tries === 1) throw new TypeError('Failed to fetch');
          return { status: 200, body: BILLING_INFO };
        },
      },
    });
    expect(view.container.querySelector('.web-page')?.getAttribute('aria-busy')).toBe('true');
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    expect(server.count('GET', ADMIN_PRICES_PATH)).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 3, name: 'Classifying posts' })).toBeTruthy();
    expect(server.count('GET', SERVER_INFO_PATH)).toBe(2);
    expect(server.count('GET', ADMIN_PRICES_PATH)).toBe(1);
    cleanup();

    // Signed out: the sign-in, which brings the person back to this page; the prices aren't asked for.
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/elsewhere', search: '', assign });
    const info = { ...BILLING_INFO, auth: { ...INFO.auth, methods: [EMAIL_OTP_METHOD, GOOGLE_METHOD] } };
    ({ server, user } = openPrices({ session: null, info }));
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`Pricing · ${INFO.name}`);
    expect(document.title).toBe(`Pricing · ${INFO.name}`);
    expect(server.count('GET', ADMIN_PRICES_PATH)).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(GOOGLE_URL));
    expect(server.posts()).toEqual([
      {
        method: 'POST',
        path: SOCIAL_SIGN_IN_PATH,
        body: {
          provider: 'google',
          callbackURL: ADMIN_PRICES_PAGE_PATH,
          errorCallbackURL: ADMIN_PRICES_PAGE_PATH,
          disableRedirect: true,
        },
      },
    ]);
    cleanup();
    vi.unstubAllGlobals();

    // Signed in, not an admin: said, with no prices and nothing to change.
    ({ server } = openPrices({ role: 'user' }));
    expect(await screen.findByText(NOT_ADMIN)).toBeTruthy();
    expect(screen.getByText(`Signed in as ${TOM}`)).toBeTruthy();
    expect(screen.queryByText('Classifying posts')).toBeNull();
    expect(screen.queryByText(/our AI cost/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change the price' })).toBeNull();
    expect(changes(server)).toEqual([]);
  });

  it('test_admin_page_links_pricing', async () => {
    fakeServer({ session: TOM, role: 'admin' });
    render(<Admin />);
    const link = await screen.findByRole('link', { name: 'Pricing' });
    expect(link.getAttribute('href')).toBe(ADMIN_PRICES_PAGE_PATH);
    // Beside "Source list", in one line under the intro.
    const line = link.closest('p') as HTMLElement;
    expect(line.textContent).toBe('Source list · Pricing');
    expect(within(line).getByRole('link', { name: 'Source list' })).toBeTruthy();
  });

  it('test_admin_prices_without_billing_banner', async () => {
    const { user } = openPrices({ info: INFO });
    const banner = (await screen.findByText(NO_BILLING)).closest('.ua-banner') as HTMLElement;
    expect(banner.className).not.toContain('ua-banner--danger');
    // The prices are shown, and the forms still open (decision PD12).
    expect(within(group('Classifying posts')).getByText('AI costs about $0.15 per 1,000 posts.')).toBeTruthy();
    await openForm(user, 'Classifying posts');
    expect(field('Our AI cost').value).toBe('0.073');
    cleanup();

    // A billing server has no banner.
    openPrices();
    expect(await screen.findByRole('heading', { level: 3, name: 'Fact-check' })).toBeTruthy();
    expect(screen.queryByText(NO_BILLING)).toBeNull();
  });
});

describe('task prices', () => {
  it('test_admin_prices_shows_prices_and_preview', async () => {
    openPrices();
    expect(await screen.findByText(INTRO)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`Pricing · ${INFO.name}`);
    expect(document.title).toBe(`Pricing · ${INFO.name}`);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Classifying posts',
      'Fact-check',
      'UnEcho Chamber',
    ]);

    const classify = within(group('Classifying posts'));
    expect(classify.getByText('Now: 2× our AI cost · Claude Haiku 5.5 · our cost $0.073 per 1,000 posts')).toBeTruthy();
    expect(classify.getByText('AI costs about $0.15 per 1,000 posts.')).toBeTruthy();
    expect(classify.getByText('$5.00 left · about 34,000 posts')).toBeTruthy();

    const factcheck = within(group('Fact-check'));
    expect(
      factcheck.getByText('Now: 2× our AI cost · Claude Sonnet 5.5 · our cost $0.12 per check · at most $0.40 for one check'),
    ).toBeTruthy();
    expect(
      factcheck.getByText(
        '2× our AI cost, typically about $0.24 per check on Claude Sonnet 5.5, and never more than $0.40 for one check.',
      ),
    ).toBeTruthy();
    expect(factcheck.getByText('About $0.24, at most $0.40')).toBeTruthy();

    const perspectives = within(group('UnEcho Chamber'));
    expect(
      perspectives.getByText(
        'Now: 2× our AI cost · Claude Sonnet 5.5 · our cost $0.135 per comparison · at most $0.50 for one comparison',
      ),
    ).toBeTruthy();
    expect(
      perspectives.getByText(
        '2× our AI cost, typically about $0.27 per comparison on Claude Sonnet 5.5, and never more than $0.50 for one comparison.',
      ),
    ).toBeTruthy();
    expect(perspectives.getByText('About $0.27, at most $0.50')).toBeTruthy();

    // No scheduled change, and every task can be changed.
    expect(screen.queryByText(/^From /)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Change the price' })).toHaveLength(3);
  });

  it('test_admin_prices_schedules_a_cut_with_confirm', async () => {
    const { server, user } = openPrices();
    await openForm(user, 'Fact-check');
    // Filled with the card in effect at the default date, the next 00:00 UTC.
    expect(field('Multiplier').value).toBe('2');
    expect(field('Reference model').value).toBe('claude-sonnet-5-5');
    expect(field('Our AI cost').value).toBe('0.12');
    expect(field('At most').value).toBe('0.40');
    expect(field('Starts on').value).toBe('2026-11-03');
    expect(field('Starts on').min).toBe('2026-11-03');
    expect(screen.getByText('This is the price already set for that day.')).toBeTruthy();
    expect(save().disabled).toBe(true);

    await retype(user, 'At most', '0.30');
    expect(screen.getByText(CUT_LINE)).toBeTruthy();
    expect(screen.getByText('People will see, from Nov 3, 2026:')).toBeTruthy();
    const form = within(screen.getByRole('form', { name: 'Change the price of Fact-check' }));
    expect(
      form.getByText(
        '2× our AI cost, typically about $0.24 per check on Claude Sonnet 5.5, and never more than $0.30 for one check.',
      ),
    ).toBeTruthy();
    expect(form.getByText('About $0.24, at most $0.30')).toBeTruthy();
    expect(save().disabled).toBe(false);

    // Saving a cut asks first; "Back" sends nothing.
    await user.click(save());
    expect(screen.getByText(CUT_QUESTION)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByText(CUT_QUESTION)).toBeNull();
    await settle();
    expect(changes(server)).toEqual([]);

    await user.click(save());
    await user.click(screen.getByRole('button', { name: 'Save the cut' }));
    await waitFor(() => expect(within(group('Fact-check')).queryByText(/^From Nov 3, 2026 \(UTC\)/)).not.toBeNull());
    expect(changes(server)).toEqual([
      {
        method: 'POST',
        path: ADMIN_PRICES_PATH,
        body: {
          action: 'schedule',
          baseVersion: '0',
          task: 'factcheck',
          effectiveFrom: '2026-11-03T00:00:00Z',
          card: {
            multiplier: 2,
            referenceModel: 'claude-sonnet-5-5',
            referenceCostMicrosPer1000: 120_000_000,
            unit: 'check',
            maxChargeMicros: 300_000,
          },
        },
      },
    ]);
    // The page loaded again: the form closed, the change listed under Fact-check with what people will see then.
    expect(server.count('GET', ADMIN_PRICES_PATH)).toBe(2);
    expect(screen.queryByLabelText('Multiplier')).toBeNull();
    const factcheck = within(group('Fact-check'));
    expect(
      factcheck.getByText(
        'From Nov 3, 2026 (UTC): 2× our AI cost · Claude Sonnet 5.5 · our cost $0.12 per check · at most $0.30 for one check',
      ),
    ).toBeTruthy();
    expect(factcheck.getByText('About $0.24, at most $0.30')).toBeTruthy();
    // The price in effect is unchanged.
    expect(factcheck.getByText('About $0.24, at most $0.40')).toBeTruthy();
    expect(within(group('UnEcho Chamber')).queryByText(/^From /)).toBeNull();
  });

  it('test_admin_prices_raise_needs_notice', async () => {
    const { server, user } = openPrices();
    await openForm(user, 'Fact-check');
    await retype(user, 'Multiplier', '2.5');
    // Dated tomorrow: the rule's own words, and no saving.
    expect(screen.getByText(RAISE_LINE)).toBeTruthy();
    expect(screen.getByText(RAISE_TOO_SOON)).toBeTruthy();
    expect(field('Starts on').value).toBe('2026-11-03');
    expect(field('Starts on').min).toBe('2026-12-03');
    expect(save().disabled).toBe(true);
    await user.click(save());
    await settle();
    expect(changes(server)).toEqual([]);

    // From Dec 3, 2026: allowed, and saved with no confirm step.
    pickDay('Starts on', '2026-12-03');
    expect(screen.getByText(RAISE_LINE)).toBeTruthy();
    expect(screen.queryByText(RAISE_TOO_SOON)).toBeNull();
    expect(screen.getByText('People will see, from Dec 3, 2026:')).toBeTruthy();
    expect(
      screen.getByText(
        '2.5× our AI cost, typically about $0.30 per check on Claude Sonnet 5.5, and never more than $0.40 for one check.',
      ),
    ).toBeTruthy();
    expect(save().disabled).toBe(false);
    await user.click(save());
    await waitFor(() => expect(changes(server)).toHaveLength(1));
    expect(screen.queryByText(CUT_QUESTION)).toBeNull();
    expect(changes(server)[0]?.body).toEqual({
      action: 'schedule',
      baseVersion: '0',
      task: 'factcheck',
      effectiveFrom: '2026-12-03T00:00:00Z',
      card: { ...FACTCHECK, multiplier: 2.5 },
    });
    expect(
      await within(group('Fact-check')).findByText(
        'From Dec 3, 2026 (UTC): 2.5× our AI cost · Claude Sonnet 5.5 · our cost $0.12 per check · at most $0.40 for one check',
      ),
    ).toBeTruthy();
  });

  it('test_admin_prices_cancel_and_move', async () => {
    const { server, user } = openPrices({ priceBook: RAISED, priceVersion: '7' });
    const factcheck = () => within(group('Fact-check'));
    expect(
      await screen.findByText(
        'From Dec 3, 2026 (UTC): 2.5× our AI cost · Claude Sonnet 5.5 · our cost $0.12 per check · at most $0.40 for one check',
      ),
    ).toBeTruthy();
    expect(
      factcheck().getByText(
        '2.5× our AI cost, typically about $0.30 per check on Claude Sonnet 5.5, and never more than $0.40 for one check.',
      ),
    ).toBeTruthy();

    // Move: a date field set to the change's date, then "Save".
    await user.click(factcheck().getByRole('button', { name: 'Move the change from Dec 3, 2026' }));
    expect(field('Move to').value).toBe('2026-12-03');
    expect(save().disabled).toBe(true);
    pickDay('Move to', '2026-12-10');
    await user.click(save());
    await waitFor(() => expect(factcheck().queryByText(/^From Dec 10, 2026 \(UTC\)/)).not.toBeNull());
    expect(changes(server)).toEqual([
      {
        method: 'POST',
        path: ADMIN_PRICES_PATH,
        body: {
          action: 'move',
          baseVersion: '7',
          task: 'factcheck',
          effectiveFrom: '2026-12-03T00:00:00Z',
          to: '2026-12-10T00:00:00Z',
        },
      },
    ]);
    expect(factcheck().queryByText(/^From Dec 3, 2026/)).toBeNull();

    // Cancel: asked first, and "Keep it" sends nothing.
    const question = 'Cancel the change from Dec 10, 2026?';
    await user.click(factcheck().getByRole('button', { name: 'Cancel the change from Dec 10, 2026' }));
    expect(screen.getByText(question)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByText(question)).toBeNull();
    await settle();
    expect(changes(server)).toHaveLength(1);

    await user.click(factcheck().getByRole('button', { name: 'Cancel the change from Dec 10, 2026' }));
    await user.click(screen.getByRole('button', { name: 'Cancel the change' }));
    await waitFor(() => expect(factcheck().queryByText(/^From /)).toBeNull());
    expect(changes(server)[1]).toEqual({
      method: 'POST',
      path: ADMIN_PRICES_PATH,
      body: { action: 'cancel', baseVersion: '8', task: 'factcheck', effectiveFrom: '2026-12-10T00:00:00Z' },
    });
    expect(screen.queryByText(question)).toBeNull();
  });

  it('test_admin_prices_form_refuses_bad_input', async () => {
    const { server, user } = openPrices();
    await openForm(user, 'Fact-check');
    await retype(user, 'At most', '0.30');
    expect(save().disabled).toBe(false);

    // A comma for the decimal point is not a multiplier.
    await retype(user, 'Multiplier', '2,5');
    expect(screen.getByText(ENTER_MULTIPLIER)).toBeTruthy();
    expect(save().disabled).toBe(true);
    await user.click(save());
    await retype(user, 'Multiplier', '2');
    expect(screen.queryByText(ENTER_MULTIPLIER)).toBeNull();
    expect(save().disabled).toBe(false);

    // Neither a negative amount, nor a fraction of a micro-dollar, nor words.
    for (const label of ['Our AI cost', 'At most']) {
      const before = field(label).value;
      for (const text of ['-1', '0.0000001', 'abc']) {
        await retype(user, label, text);
        expect(screen.getByText(ENTER_AMOUNT), `${label}: ${text}`).toBeTruthy();
        expect(save().disabled, `${label}: ${text}`).toBe(true);
        await user.click(save());
      }
      await retype(user, label, before);
      expect(screen.queryByText(ENTER_AMOUNT)).toBeNull();
    }
    expect(save().disabled).toBe(false);

    // "Cancel" closes the form; nothing was ever sent.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Multiplier')).toBeNull();
    await settle();
    expect(changes(server)).toEqual([]);
  });

  it('test_admin_prices_refusals', async () => {
    // 400: the server's message, in a danger banner; the form stays as typed.
    const message = 'The multiplier must be from 1× to 10×: never below our AI cost.';
    let { server, user } = openPrices({
      routes: { [`POST ${ADMIN_PRICES_PATH}`]: { status: 400, body: { code: 'bad-request', message } } },
    });
    await openForm(user, 'Classifying posts');
    await retype(user, 'Multiplier', '1.5');
    await user.click(save());
    await user.click(screen.getByRole('button', { name: 'Save the cut' }));
    const refused = await screen.findByText(message);
    expect(refused.closest('.ua-banner')?.className).toContain('ua-banner--danger');
    expect(field('Multiplier').value).toBe('1.5');
    expect(screen.queryByText(CUT_QUESTION)).toBeNull();
    cleanup();

    // 409: said, with "Reload", which asks for the prices again.
    ({ server, user } = openPrices({ routes: { [`POST ${ADMIN_PRICES_PATH}`]: PRICES_CHANGED } }));
    await openForm(user, 'Fact-check');
    await retype(user, 'At most', '0.30');
    await user.click(save());
    await user.click(screen.getByRole('button', { name: 'Save the cut' }));
    expect(await screen.findByText(CHANGED)).toBeTruthy();
    expect(screen.queryByText(PRICES_CHANGED.body.message)).toBeNull();
    expect(server.count('GET', ADMIN_PRICES_PATH)).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.queryByText(CHANGED)).toBeNull());
    expect(server.count('GET', ADMIN_PRICES_PATH)).toBe(2);
    cleanup();

    // 404: said, and the prices are asked for again at once.
    ({ server, user } = openPrices({
      priceBook: RAISED,
      priceVersion: '7',
      routes: { [`POST ${ADMIN_PRICES_PATH}`]: PRICE_CHANGE_GONE },
    }));
    await user.click(await screen.findByRole('button', { name: 'Cancel the change from Dec 3, 2026' }));
    await user.click(screen.getByRole('button', { name: 'Cancel the change' }));
    expect(await screen.findByText(GONE)).toBeTruthy();
    await waitFor(() => expect(server.count('GET', ADMIN_PRICES_PATH)).toBe(2));
    expect(screen.queryByText('Cancel the change from Dec 3, 2026?')).toBeNull();
    cleanup();

    // 401: back to the sign-in, saying so.
    ({ server, user } = openPrices({ routes: { [`POST ${ADMIN_PRICES_PATH}`]: SESSION_GONE } }));
    await openForm(user, 'Fact-check');
    await retype(user, 'At most', '0.30');
    await user.click(save());
    await user.click(screen.getByRole('button', { name: 'Save the cut' }));
    expect(await screen.findByText(SIGNED_OUT)).toBeTruthy();
    expect(screen.getByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(screen.queryByText('Classifying posts')).toBeNull();
  });

  it('test_parse_dollars_is_exact', () => {
    expect(parseDollars('0.073')).toBe(73_000);
    expect(parseDollars('$12.5')).toBe(12_500_000);
    // String arithmetic: 0.29 × 1,000,000 in floating point is 290000.00000000006.
    expect(parseDollars('0.29')).toBe(290_000);
    expect(parseDollars('1.005')).toBe(1_005_000);
    expect(parseDollars('0.000001')).toBe(1);
    expect(parseDollars('999999.999999')).toBe(999_999_999_999);
    expect(parseDollars('12')).toBe(12_000_000);
    for (const text of ['1e3', '-1', '0.0000001', 'abc', '', '$', '.5', '1.', '1,000', '1234567', '$-1', 'Infinity']) {
      expect(parseDollars(text), text).toBeNull();
    }
    // What the form fills in reads back as the same amount.
    for (const micros of [73_000, 400_000, 1, 12_500_000, 120_000]) expect(parseDollars(dollarsInput(micros))).toBe(micros);
    expect(dollarsInput(73_000)).toBe('0.073');
    expect(dollarsInput(400_000)).toBe('0.40');
    expect(dollarsInput(12_500_000)).toBe('12.50');
    // A job's cost per check, from its cost per 1,000 checks in micro-dollars (nano-dollars per check).
    expect(dollarsInput(120_000_000, 9)).toBe('0.12');
    expect(dollarsInput(135_000_000, 9)).toBe('0.135');

    expect(parseMultiplier('2')).toBe(2);
    expect(parseMultiplier('1.15')).toBe(1.15);
    expect(parseMultiplier('2.5')).toBe(2.5);
    for (const text of ['2,5', '1.12345', '100', '', 'abc', '-2', '1e1']) expect(parseMultiplier(text), text).toBeNull();

    expect(utcDayInput('2026-11-03T00:00:00Z')).toBe('2026-11-03');
    expect(fromUtcDayInput('2026-12-10')).toBe('2026-12-10T00:00:00Z');
    expect(fromUtcDayInput('')).toBeNull();
    expect(fromUtcDayInput('2026-12-1')).toBeNull();
    expect(fromUtcDayInput('2026-02-30')).toBeNull();
  });
});
