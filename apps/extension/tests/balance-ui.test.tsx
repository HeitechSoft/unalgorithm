/**
 * The credit balance on the extension's own pages (R27, R31): a pill in the popup footer and under the Settings account
 * row, a low-balance banner at most once a day, the paused banner at $0, and nothing about credit in the feed.
 * `aiStatus` is answered per test, storage is the WXT fake browser, and today is a fake `Date` (local time, as
 * `dateKey` reads it).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describeError } from '@unalgorithm/ai';
import { type AISourceConfig, type Device, dateKey, defaultDevice } from '@unalgorithm/core';
import { LOW_BALANCE_MICROS } from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { PublicBalance } from '../src/background/server-balance.ts';
import { BalancePill, shouldShowLowBalance } from '../src/components/BalancePill.tsx';
import { ServerSetup } from '../src/components/ServerSetup.tsx';
import { App as Popup } from '../src/entrypoints/popup/App.tsx';
import { type AiStatus, type BgRequest, type PublicServerAccount, sendToBackground } from '../src/lib/messages.ts';
import { PINNED_CLOUD_ORIGIN, serverLabel } from '../src/lib/server-label.ts';
import { deviceItem, lowBalanceNoticeItem } from '../src/lib/storage.ts';

vi.mock('../src/lib/messages.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/messages.ts')>()),
  sendToBackground: vi.fn(),
}));

const CFG: AISourceConfig = { kind: 'server', baseUrl: PINNED_CLOUD_ORIGIN };
const LABEL = serverLabel(PINNED_CLOUD_ORIGIN).title;
const ACCOUNT_URL = 'https://cloud.unalgorithm.app/account';
const EMAIL = 'ada@example.org';
const TODAY = new Date(2026, 9, 14, 10);
const YESTERDAY = new Date(2026, 9, 13, 10);
const FEED_TAB = { id: 7, url: 'https://www.linkedin.com/feed/', windowId: 0 };
const FULL_TEXT = '$0.97 left · about 6,600 posts';
const LOW_TEXT = '$0.15 left · about 1,000 posts';
const PAUSED_ENDING = 'Add credit, or switch to on-device or your own key.';
const LOW_TITLE = 'Your balance is low';
const FEED_DIRS = [
  'apps/extension/src/content',
  'apps/extension/src/entrypoints/linkedin.content',
  'apps/extension/src/entrypoints/facebook.content',
  'packages/ui/src/feed',
];
const CREDIT_NAMES = [
  'BalancePill',
  'lowBalanceNoticeItem',
  'serverBalanceItem',
  'balanceLine',
  'formatBalance',
  'CREDIT_BALANCE_PATH',
];
const REPO = resolve(import.meta.dirname, '../../..');

/** What `balanceStatus` reports for `balanceMicros` on the Cloud (CL2-10). */
const balance = (balanceMicros: number, over: Partial<PublicBalance> = {}): PublicBalance => ({
  balanceMicros,
  low: balanceMicros > 0 && balanceMicros < LOW_BALANCE_MICROS,
  empty: balanceMicros <= 0,
  accountUrl: ACCOUNT_URL,
  updatedAt: TODAY.getTime(),
  ...over,
});

/** The background's `aiStatus` for the Cloud, with the R27 message when the balance is empty. */
const cloudStatus = (b?: PublicBalance): AiStatus => ({
  configured: true,
  kind: 'server',
  label: LABEL,
  state: b?.empty ? 'needs-attention' : 'ready',
  ...(b?.empty ? { message: describeError('insufficient-credits', LABEL) } : {}),
  postsToday: 0,
  dailyCap: 300,
  capApplies: true,
  ...(b ? { balance: b } : {}),
});
const SELF_HOSTED_STATUS: AiStatus = { ...cloudStatus(), label: 'ai.example.org' };
const AI_OFF_STATUS: AiStatus = {
  configured: false,
  kind: null,
  label: 'Off',
  state: 'off',
  postsToday: 0,
  dailyCap: 300,
  capApplies: false,
};

const pillName = (text: string) => `Credit balance: ${text}. Open your account.`;
const device = (): Device => ({ ...defaultDevice('dev1'), aiSource: CFG });
const account: PublicServerAccount = {
  origin: PINNED_CLOUD_ORIGIN,
  email: EMAIL,
  signedInAt: TODAY.getTime(),
  needsSignIn: false,
  label: serverLabel(PINNED_CLOUD_ORIGIN),
  billing: true,
};

let aiReply: () => AiStatus | Promise<AiStatus>;
/** What `serverAccount` reports; `serverSignIn` answers with the same account, signed in. */
let serverAccount: PublicServerAccount;
let activeTab: typeof FEED_TAB | null;
let created: MockInstance;
let closed: MockInstance;

const sentTypes = () => vi.mocked(sendToBackground).mock.calls.map(([msg]) => msg.type);

beforeEach(async () => {
  fakeBrowser.reset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
  activeTab = null;
  aiReply = () => cloudStatus();
  serverAccount = account;
  vi.mocked(sendToBackground).mockReset();
  vi.mocked(sendToBackground).mockImplementation(async (msg: BgRequest) => {
    if (msg.type === 'aiStatus') return (await aiReply()) as never;
    if (msg.type === 'serverAccount') return { account: serverAccount } as never;
    if (msg.type === 'serverSignIn') return { ok: true, account: { ...serverAccount, needsSignIn: false } } as never;
    throw new Error(`No reply to ${msg.type}`);
  });
  // `as never`: spyOn picks the callback overloads. The fake browser has no focused window to answer `query` from.
  vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((async () =>
    activeTab ? [{ ...activeTab, active: true }] : []) as never);
  created = vi.spyOn(fakeBrowser.tabs, 'create');
  // jsdom's `window.close` tears the document down.
  closed = vi.spyOn(window, 'close').mockImplementation(() => undefined);
  await deviceItem.setValue(device());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Opens the popup on a LinkedIn feed tab or on any other page, and waits for its footer. */
async function openPopup(on: 'feed' | 'elsewhere' = 'elsewhere') {
  activeTab = on === 'feed' ? FEED_TAB : null;
  render(<Popup />);
  const footer = await waitFor(() => {
    const el = document.querySelector('footer');
    if (!el) throw new Error('no footer yet');
    return el;
  });
  if (on === 'feed') await within(footer).findByRole('button', { name: 'Report a problem' });
  return footer;
}

/** Lets pending storage reads, writes and change events land. */
const settle = () => act(() => new Promise<void>((done) => setTimeout(done, 30)));

/** The source files under `dir` (fails when there are none, so a moved folder can't pass by being empty). */
function sourceFiles(dir: string): string[] {
  const files = (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => join(dir, f))
    .filter((f) => /\.(ts|tsx|css)$/.test(f) && statSync(f).isFile());
  expect(files.length, dir).toBeGreaterThan(0);
  return files;
}

/** Every `file: name` where one of `files` names one of `names`. */
function namesIn(files: string[], names: string[]): string[] {
  return files.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return names.filter((name) => new RegExp(`\\b${name}\\b`).test(text)).map((name) => `${file}: ${name}`);
  });
}

describe('pill', () => {
  it('test_balance_pill_text_and_name', () => {
    const onOpen = vi.fn();
    render(<BalancePill balance={balance(970_000)} onOpen={onOpen} />);
    const pill = screen.getByRole('button', { name: pillName(FULL_TEXT) }) as HTMLButtonElement;
    expect(pill.textContent).toBe(FULL_TEXT);
    expect(pill.disabled).toBe(false);
    fireEvent.click(pill);
    expect(onOpen).toHaveBeenCalledTimes(1);
    cleanup();

    // No account page to open: shown, but not a button that does nothing.
    render(<BalancePill balance={balance(970_000, { accountUrl: null })} onOpen={onOpen} />);
    const noLink = screen.getByRole('button', { name: `Credit balance: ${FULL_TEXT}.` }) as HTMLButtonElement;
    expect(noLink.disabled).toBe(true);
    fireEvent.click(noLink);
    expect(onOpen).toHaveBeenCalledTimes(1);
    cleanup();

    render(<BalancePill balance={balance(970_000)} />);
    expect((screen.getByRole('button', { name: `Credit balance: ${FULL_TEXT}.` }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('test_balance_pill_tones', () => {
    const badge = (micros: number) => {
      render(<BalancePill balance={balance(micros)} onOpen={() => undefined} />);
      const el = document.querySelector('.ua-badge');
      const found = { className: el?.className, text: el?.textContent };
      cleanup();
      return found;
    };
    expect(badge(150_000)).toEqual({ className: 'ua-badge ua-badge--warning', text: LOW_TEXT });
    expect(badge(0)).toEqual({ className: 'ua-badge ua-badge--danger', text: '$0.00 left' });
    expect(badge(970_000)).toEqual({ className: 'ua-badge', text: FULL_TEXT });

    // `Badge` builds the class from the tone; without a rule the $0 pill would look like the neutral one.
    const css = readFileSync(resolve(REPO, 'packages/ui/src/styles/components.css'), 'utf8');
    const rule = /\.ua-badge--danger\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/background:\s*var\(--ua-danger-tint\);/);
    expect(rule).toMatch(/(^|[;\s])color:\s*var\(--ua-danger\);/);
  });

  it('test_should_show_low_balance', () => {
    const today = dateKey(TODAY);
    const yesterday = dateKey(YESTERDAY);
    expect(shouldShowLowBalance(balance(150_000), null, today)).toBe(true);
    expect(shouldShowLowBalance(balance(150_000), yesterday, today)).toBe(true);
    expect(shouldShowLowBalance(balance(150_000), today, today)).toBe(false);
    expect(shouldShowLowBalance(balance(970_000), null, today)).toBe(false);
    expect(shouldShowLowBalance(balance(0), null, today)).toBe(false);
    expect(shouldShowLowBalance(undefined, null, today)).toBe(false);
  });
});

describe('popup', () => {
  it('test_popup_footer_pill_opens_account', async () => {
    aiReply = () => cloudStatus(balance(970_000));
    for (const on of ['elsewhere', 'feed'] as const) {
      const footer = await openPopup(on);
      const pill = await within(footer).findByRole('button', { name: pillName(FULL_TEXT) });
      // Right after the AI status button, in the same group.
      expect(within(footer).getByRole('button', { name: `${LABEL} · Ready` }).nextElementSibling).toBe(pill);
      fireEvent.click(pill);
      expect(created).toHaveBeenCalledWith({ url: ACCOUNT_URL });
      expect(closed).toHaveBeenCalledTimes(1);
      await settle();
      expect(screen.queryByText('AI is paused')).toBeNull();
      expect(screen.queryByText(LOW_TITLE)).toBeNull();
      cleanup();
      created.mockClear();
      closed.mockClear();
    }
  });

  it('test_popup_paused_banner_actions', async () => {
    aiReply = () => cloudStatus(balance(0));
    for (const on of ['elsewhere', 'feed'] as const) {
      await openPopup(on);
      const message = await screen.findByText(describeError('insufficient-credits', LABEL));
      expect(message.textContent?.endsWith(PAUSED_ENDING)).toBe(true);
      const banner = message.closest('.ua-banner') as HTMLElement;
      expect(banner.className).toContain('ua-banner--warning');
      expect(within(banner).getByText('AI is paused')).toBeTruthy();
      // At the top of the stack, above the setup banner.
      expect(banner.parentElement?.firstElementChild).toBe(banner);
      const setup = screen.getByText('Finish setup, about a minute').closest('.ua-banner') as HTMLElement;
      expect(banner.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByRole('button', { name: pillName('$0.00 left') }).querySelector('.ua-badge--danger')).not.toBeNull();

      fireEvent.click(within(banner).getByRole('button', { name: 'Add credit' }));
      expect(created).toHaveBeenLastCalledWith({ url: ACCOUNT_URL });
      fireEvent.click(within(banner).getByRole('button', { name: 'Switch AI' }));
      expect(created).toHaveBeenLastCalledWith({ url: `chrome-extension://${fakeBrowser.runtime.id}/options.html#/ai` });
      expect(closed).toHaveBeenCalledTimes(2);
      // A state, not a promotion: it has no Dismiss, and no low-balance banner comes with it.
      expect(within(banner).queryByRole('button', { name: 'Dismiss' })).toBeNull();
      await settle();
      expect(screen.queryByText(LOW_TITLE)).toBeNull();
      cleanup();
      created.mockClear();
      closed.mockClear();
    }
  });

  it('test_popup_low_balance_once_a_day', async () => {
    aiReply = () => cloudStatus(balance(150_000));
    const delivered = new Promise<string | null>((done) => {
      const stop = lowBalanceNoticeItem.watch((value) => {
        stop();
        done(value);
      });
    });
    await openPopup();
    const banner = (await screen.findByText(LOW_TITLE)).closest('.ua-banner') as HTMLElement;
    expect(banner.className).toContain('ua-banner--info');
    expect(within(banner).getByText(LOW_TEXT)).toBeTruthy();
    // Stamped with today's date only, and the change reached the watchers: the banner stays.
    expect(await delivered).toBe(dateKey(TODAY));
    expect(await fakeBrowser.storage.local.get('lowBalanceNoticeOn')).toEqual({ lowBalanceNoticeOn: '2026-10-14' });
    await settle();
    expect(screen.getByText(LOW_TITLE)).toBeTruthy();
    expect(screen.getByRole('button', { name: pillName(LOW_TEXT) }).querySelector('.ua-badge--warning')).not.toBeNull();
    fireEvent.click(within(banner).getByRole('button', { name: 'Add credit' }));
    expect(created).toHaveBeenCalledWith({ url: ACCOUNT_URL });
    // Dismiss hides it for the rest of the popup's life.
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(LOW_TITLE)).toBeNull();
    await settle();
    expect(screen.queryByText(LOW_TITLE)).toBeNull();
    cleanup();

    // Opened again the same day: no banner, and no second stamp.
    const write = vi.spyOn(lowBalanceNoticeItem, 'setValue');
    await openPopup();
    await screen.findByRole('button', { name: pillName(LOW_TEXT) });
    await settle();
    expect(screen.queryByText(LOW_TITLE)).toBeNull();
    expect(write).not.toHaveBeenCalled();
    cleanup();

    // Last shown yesterday: once more today.
    await lowBalanceNoticeItem.setValue(dateKey(YESTERDAY));
    write.mockClear();
    await openPopup('feed');
    expect(await screen.findByText(LOW_TITLE)).toBeTruthy();
    await waitFor(() => expect(write).toHaveBeenCalledWith('2026-10-14'));
    await settle();
    expect(screen.getByText(LOW_TITLE)).toBeTruthy();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('test_popup_low_balance_waits_for_stamp', async () => {
    await lowBalanceNoticeItem.setValue(dateKey(TODAY));
    let release = () => undefined as void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const read = lowBalanceNoticeItem.getValue.bind(lowBalanceNoticeItem);
    const reads = vi.spyOn(lowBalanceNoticeItem, 'getValue').mockImplementation(async () => {
      await gate;
      return read();
    });
    const write = vi.spyOn(lowBalanceNoticeItem, 'setValue');
    // Any banner, even one that shows for a moment.
    let shown = false;
    const observer = new MutationObserver((records) => {
      for (const r of records)
        for (const node of [...r.addedNodes, r.target]) if (node.textContent?.includes(LOW_TITLE)) shown = true;
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    aiReply = () => cloudStatus(balance(150_000));
    await openPopup();
    // `aiStatus` has answered while the stamp is still being read.
    await screen.findByRole('button', { name: pillName(LOW_TEXT) });
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(shown).toBe(false);

    release();
    await settle();
    observer.disconnect();
    expect(shown).toBe(false);
    expect(screen.queryByText(LOW_TITLE)).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(await fakeBrowser.storage.local.get('lowBalanceNoticeOn')).toEqual({ lowBalanceNoticeOn: '2026-10-14' });
  });

  it('test_no_credit_ui_without_balance', async () => {
    const write = vi.spyOn(lowBalanceNoticeItem, 'setValue');
    for (const [reply, aiButton] of [
      [SELF_HOSTED_STATUS, 'ai.example.org · Ready'],
      [AI_OFF_STATUS, 'AI off · rules only'],
    ] as const) {
      aiReply = () => reply;
      for (const on of ['elsewhere', 'feed'] as const) {
        const footer = await openPopup(on);
        await within(footer).findByRole('button', { name: aiButton });
        await settle();
        expect(screen.queryByRole('button', { name: /^Credit balance/ })).toBeNull();
        expect(screen.queryByText('AI is paused')).toBeNull();
        expect(screen.queryByText(LOW_TITLE)).toBeNull();
        cleanup();
      }

      // Settings: signed in, no pill.
      render(<ServerSetup device={device()} />);
      await screen.findByText(`Signed in as ${EMAIL}`);
      await settle();
      expect(sentTypes()).toContain('aiStatus');
      expect(screen.queryByRole('button', { name: /^Credit balance/ })).toBeNull();
      cleanup();
    }
    expect(write).not.toHaveBeenCalled();
  });
});

describe('settings', () => {
  it('test_settings_account_row_pill', async () => {
    aiReply = () => cloudStatus(balance(970_000));
    render(<ServerSetup device={device()} />);
    const row = (await screen.findByText(`Signed in as ${EMAIL}`)).closest('.ua-row') as HTMLElement;
    const pill = await screen.findByRole('button', { name: pillName(FULL_TEXT) });
    // In the account card, directly under the account row.
    expect(row.closest('.ua-card')?.contains(pill)).toBe(true);
    expect(row.nextElementSibling?.contains(pill)).toBe(true);
    // `aiStatus` goes out before the account is read (server-setup.test.tsx relies on the order after it).
    expect(sentTypes().slice(0, 2)).toEqual(['aiStatus', 'serverAccount']);
    fireEvent.click(pill);
    expect(created).toHaveBeenCalledWith({ url: ACCOUNT_URL });
    expect(closed).not.toHaveBeenCalled();
    cleanup();

    // No banners in Settings, low or empty: the pill's tone says it.
    for (const [micros, text, tone] of [
      [150_000, LOW_TEXT, 'warning'],
      [0, '$0.00 left', 'danger'],
    ] as const) {
      aiReply = () => cloudStatus(balance(micros));
      render(<ServerSetup device={device()} />);
      const found = await screen.findByRole('button', { name: pillName(text) });
      expect(found.querySelector(`.ua-badge--${tone}`)).not.toBeNull();
      expect(screen.queryByText('AI is paused')).toBeNull();
      expect(screen.queryByText(LOW_TITLE)).toBeNull();
      cleanup();
    }
  });

  it('test_settings_pill_after_sign_in_again', async () => {
    // `as never`: spyOn picks the callback overload, typed as returning void.
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation((async () => true) as never);
    const afterSignIn = () => sentTypes().slice(sentTypes().indexOf('serverSignIn') + 1);
    // R26: the source stays the Cloud throughout, so the device never changes. While the account must sign in again,
    // `aiStatus` has no balance (CL2-10); once signed in, a server that bills has one.
    for (const billing of [true, false]) {
      vi.mocked(sendToBackground).mockClear();
      serverAccount = { ...account, needsSignIn: true, billing };
      aiReply = () =>
        !sentTypes().includes('serverSignIn')
          ? { ...cloudStatus(), state: 'needs-attention', message: describeError('auth-required', LABEL) }
          : cloudStatus(billing ? balance(970_000) : undefined);
      render(<ServerSetup device={device()} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }));
      await screen.findByText(`Signed in as ${EMAIL}`);
      if (billing) {
        expect(await screen.findByRole('button', { name: pillName(FULL_TEXT) })).toBeTruthy();
        expect(afterSignIn()).toEqual(['aiStatus']);
      } else {
        // No balance to show, so nothing more is asked (server-setup.test.tsx checks the same order).
        await settle();
        expect(afterSignIn()).toEqual([]);
        expect(screen.queryByRole('button', { name: /^Credit balance/ })).toBeNull();
      }
      cleanup();
    }
  });
});

describe('feed isolation', () => {
  it('test_feed_never_shows_credits', () => {
    for (const dir of FEED_DIRS) {
      const files = sourceFiles(resolve(REPO, dir));
      expect(namesIn(files, CREDIT_NAMES), dir).toEqual([]);
      // Nor do content scripts ask for `aiStatus`, which carries the balance (the background refuses them, CL2-10).
      expect(
        files.filter((f) => /type:\s*['"]aiStatus['"]/.test(readFileSync(f, 'utf8'))),
        dir,
      ).toEqual([]);
    }
    // The same scan finds the names where they are used.
    expect(namesIn(sourceFiles(resolve(REPO, 'apps/extension/src/entrypoints/popup')), CREDIT_NAMES)).not.toEqual([]);
  });
});
