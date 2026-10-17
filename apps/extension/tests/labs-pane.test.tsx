/**
 * Fact-check and UnEcho Chamber out of Labs (P3-64, D77, D78): their switches sit at the end of Settings → AI, next to
 * the source they need. The Fact-check switch works only with a source that can fact-check and writes the device-local
 * `labs.factcheck` flag, whose stored name and value are kept from Labs. The UnEcho Chamber row (P3-40) shows on every
 * build (D103), with the source list it uses under it. The sidebar has no Labs item; `#/labs` opens the AI pane.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import {
  type AISourceConfig,
  type Device,
  defaultDevice,
  defaultSettings,
  migrateDevice,
  type OwnOutlet,
  type Settings,
} from '@unalgorithm/core';
import { FIXTURE_OFFICIAL_LIST } from '@unalgorithm/outlets/testing';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { App } from '../src/entrypoints/options/App.tsx';
import { AiPane } from '../src/entrypoints/options/panes.tsx';
import { officialListItem, serverOfferItem } from '../src/lib/storage.ts';

vi.mock('../src/lib/messages.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/messages.ts')>()),
  sendToBackground: vi.fn(async () => undefined),
  sendQuietly: vi.fn(),
}));

const device = (aiSource: AISourceConfig | null): Device => ({ ...defaultDevice('dev1'), aiSource });
const NOT_CAPABLE = 'Needs your own Anthropic or OpenAI key, or a server that offers it.';
const ORIGIN = 'https://unalgo.example';
const COMPAT: AISourceConfig = {
  kind: 'openai-compatible',
  preset: 'groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  auth: 'bearer',
  model: 'llama',
};

/** A saveDevice that applies each change to `holder.stored`, as the real one does to storage. */
function deviceStore(initial: Device) {
  const holder = { stored: initial };
  const saveDevice = vi.fn(async (m: (d: Device) => void) => {
    const next = structuredClone(holder.stored);
    m(next);
    holder.stored = next;
  });
  return { holder, saveDevice };
}

function renderAi(d: Device, saveDevice: (m: (d: Device) => void) => Promise<void> = vi.fn(async () => {})) {
  return render(<AiPane settings={defaultSettings()} save={vi.fn(async () => {})} device={d} saveDevice={saveDevice} />);
}

const factcheckSwitch = () => screen.getByRole('switch', { name: 'Fact-check' }) as HTMLButtonElement;
/** True when `a` comes before `b` in the document. */
const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

afterEach(() => {
  cleanup();
  location.hash = '';
  fakeBrowser.reset();
});

describe('Settings → AI: Fact-check and UnEcho Chamber', () => {
  it('test_ai_pane_factcheck_switch_saves_flag', async () => {
    const user = setupUser();
    const { holder, saveDevice } = deviceStore(device({ kind: 'anthropic', model: null }));
    renderAi(holder.stored, saveDevice);
    expect(screen.getByRole('heading', { level: 1, name: 'AI' })).toBeTruthy();
    expect(screen.queryByText(/\bLabs\b/)).toBeNull();
    // Its own group at the end of the pane, after the daily limit; no "Set up AI" (the person is on the AI pane).
    const header = screen.getByRole('heading', { level: 3, name: 'Fact-check' });
    expect(before(screen.getByRole('heading', { level: 3, name: 'Daily limit' }), header)).toBe(true);
    expect(
      within(header.closest('section') as HTMLElement).getByText(
        'Adds Check facts to public posts that make factual claims. It runs only when you click, on the AI you chose above, and shows the price first. AI can be wrong, so open the sources.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up AI' })).toBeNull();
    const sw = factcheckSwitch();
    expect(sw.disabled).toBe(false);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByText(NOT_CAPABLE)).toBeNull();
    await user.click(sw);
    expect(saveDevice).toHaveBeenCalledTimes(1);
    expect(holder.stored.labs.factcheck).toBe(true);
  });

  it('test_ai_pane_keeps_factcheck_on_from_labs', () => {
    // A device that turned Fact-check on in Labs: the stored flag keeps its name and value, with no migration.
    const fromLabs: Device = { ...device({ kind: 'anthropic', model: null }), labs: { factcheck: true, perspectives: false } };
    expect(migrateDevice(structuredClone(fromLabs), () => 'other').labs).toStrictEqual({ factcheck: true, perspectives: false });
    expect(defaultDevice('x').labs).toStrictEqual({ factcheck: false, perspectives: false });
    renderAi(fromLabs);
    const sw = factcheckSwitch();
    expect(sw.disabled).toBe(false);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('test_ai_pane_factcheck_disabled_reasons', async () => {
    // No source (and on-device): disabled and off, even with a flag stored earlier, which stays stored.
    for (const source of [null, { kind: 'on-device' } as const]) {
      const user = setupUser();
      const saveDevice = vi.fn(async () => {});
      renderAi({ ...device(source), labs: { factcheck: true, perspectives: false } }, saveDevice);
      const sw = factcheckSwitch();
      expect(sw.disabled).toBe(true);
      expect(sw.getAttribute('aria-checked')).toBe('false');
      // The same reason under Fact-check and under UnEcho Chamber, shown on every build.
      expect(screen.getAllByText(NOT_CAPABLE)).toHaveLength(2);
      expect(screen.queryByRole('button', { name: 'Set up AI' })).toBeNull();
      await user.click(sw);
      expect(saveDevice).not.toHaveBeenCalled();
      cleanup();
    }

    // A server whose offer lacks fact-check: the server's own reason.
    await serverOfferItem.setValue({
      origin: ORIGIN,
      billing: false,
      factcheck: false,
      factcheckPrice: null,
      perspectives: true,
      perspectivesPrice: null,
    });
    renderAi(device({ kind: 'server', baseUrl: ORIGIN }));
    await act(async () => {});
    expect(factcheckSwitch().disabled).toBe(true);
    expect(screen.getByText("Your server doesn't offer fact-check.")).toBeTruthy();
    cleanup();

    // An OpenAI-compatible source: the web search key section above the switch, which needs a key.
    renderAi(device(COMPAT));
    expect(before(screen.getByRole('heading', { name: 'Web search key' }), factcheckSwitch())).toBe(true);
    expect(factcheckSwitch().disabled).toBe(true);
    expect(screen.getAllByText('Needs a web search key (above).')).toHaveLength(2);
  });

  it('test_ai_pane_server_offer_enables_switch', async () => {
    renderAi(device({ kind: 'server', baseUrl: ORIGIN }));
    expect(factcheckSwitch().disabled).toBe(true);
    expect(screen.getByText("Your server doesn't offer fact-check.")).toBeTruthy();
    // The server starts offering it: the switch turns on live, without a reload (once the first read has settled).
    await act(async () => {});
    await serverOfferItem.setValue({
      origin: ORIGIN,
      billing: false,
      factcheck: true,
      factcheckPrice: null,
      perspectives: false,
      perspectivesPrice: null,
    });
    await waitFor(() => expect(factcheckSwitch().disabled).toBe(false));
    expect(screen.queryByText("Your server doesn't offer fact-check.")).toBeNull();
  });

  it('test_ai_pane_unecho_chamber_on_every_build', async () => {
    // A store or development build (not e2e), no list downloaded yet, an Anthropic source: an enabled switch that sets
    // `labs.perspectives` (D103).
    expect(import.meta.env.MODE).not.toBe('e2e');
    const user = setupUser();
    const { holder, saveDevice } = deviceStore(device({ kind: 'anthropic', model: null }));
    renderAi(holder.stored, saveDevice);
    const header = screen.getByRole('heading', { level: 3, name: 'UnEcho Chamber' });
    expect(before(screen.getByRole('heading', { level: 3, name: 'Fact-check' }), header)).toBe(true);
    const footer = within(header.closest('section') as HTMLElement).getByText(/^Adds UnEcho Chamber/);
    expect(footer.textContent).toBe(
      "Adds UnEcho Chamber to public posts that share a news link. It runs only when you click and shows the price first. It sends the link, its title and the web addresses of your chosen list's outlets with a lean, never the post. Leans come from people, never from AI. AI can be wrong, so open the sources.",
    );
    const sw = screen.getByRole('switch', { name: 'UnEcho Chamber' }) as HTMLButtonElement;
    expect(sw.disabled).toBe(false);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await user.click(sw);
    expect(saveDevice).toHaveBeenCalledTimes(1);
    expect(holder.stored.labs).toStrictEqual({ factcheck: false, perspectives: true });
    cleanup();

    // A server whose offer has fact-check but not UnEcho Chamber.
    await serverOfferItem.setValue({
      origin: ORIGIN,
      billing: false,
      factcheck: true,
      factcheckPrice: null,
      perspectives: false,
      perspectivesPrice: null,
    });
    const onServer: Device = { ...device({ kind: 'server', baseUrl: ORIGIN }), labs: { factcheck: true, perspectives: true } };
    const save = vi.fn(async () => {});
    renderAi(onServer, save);
    await waitFor(() => expect(factcheckSwitch().disabled).toBe(false));
    const off = screen.getByRole('switch', { name: 'UnEcho Chamber' }) as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    expect(off.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText("Your server doesn't offer UnEcho Chamber.")).toBeTruthy();
    await user.click(off);
    expect(save).not.toHaveBeenCalled();
  });

  it('test_ai_pane_source_list_choice', async () => {
    // P3-76 (D100, D110): the list UnEcho Chamber uses, chosen under its switch; the choice is a synced setting.
    const user = setupUser();
    const own = (name: string, domain: string, bucket: OwnOutlet['bucket']): OwnOutlet => ({
      name,
      domains: [domain],
      bucket,
      addedAt: 1,
    });
    const holder = { stored: defaultSettings() };
    holder.stored.perspectives.outlets = {
      'fx-a': own('FX Alpha', 'alpha.example', 'left'),
      'fx-b': own('FX Beta', 'beta.example', 'right'),
      'fx-c': own('FX Gamma', 'gamma.example', null),
    };
    const save = vi.fn(async (m: (s: Settings) => Settings | void) => {
      const next = structuredClone(holder.stored);
      holder.stored = (m(next) ?? next) as Settings;
    });
    const anthropic = device({ kind: 'anthropic', model: null });
    const pane = () => <AiPane settings={holder.stored} save={save} device={anthropic} saveDevice={vi.fn(async () => {})} />;
    const { rerender } = render(pane());

    // unAlgorithm Cloud's list by default, under the switch; nothing downloaded yet.
    const cloud = screen.getByRole('radio', { name: "unAlgorithm Cloud's list" }) as HTMLInputElement;
    expect(cloud.checked).toBe(true);
    expect(before(screen.getByRole('switch', { name: 'UnEcho Chamber' }), cloud)).toBe(true);
    expect(screen.getByText('Not downloaded yet: it downloads once UnEcho Chamber is on')).toBeTruthy();
    expect(screen.queryByText(/\d+ outlets? with a lean/)).toBeNull();

    // Your own list: saved as the setting, with its count and its balance.
    await user.click(screen.getByRole('radio', { name: 'Your own list' }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(holder.stored.perspectives.list).toBe('own');
    expect(holder.stored.perspectives.outlets).toHaveProperty('fx-c');
    rerender(pane());
    expect((screen.getByRole('radio', { name: 'Your own list' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('2 outlets with a lean')).toBeTruthy();
    expect(screen.getByText("Your list isn't balanced")).toBeTruthy();
    expect(screen.queryByText(/Not downloaded yet/)).toBeNull();

    // Back on the Cloud's list, now stored: its version and count.
    await officialListItem.setValue({ list: FIXTURE_OFFICIAL_LIST, checkedAt: 1 });
    await user.click(screen.getByRole('radio', { name: "unAlgorithm Cloud's list" }));
    rerender(pane());
    expect(holder.stored.perspectives.list).toBe('cloud');
    expect(await screen.findByText('Version 1, 10 outlets with a lean')).toBeTruthy();
    expect(screen.queryByText("Your list isn't balanced")).toBeNull();

    // Edit your list opens the editor at #/ai/sources, inside the AI pane.
    await user.click(screen.getByRole('button', { name: 'Edit your list' }));
    expect(location.hash).toBe('#/ai/sources');
    cleanup();
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Your source list' })).toBeTruthy();
    const current = screen.getByRole('navigation', { name: 'Settings' }).querySelector('[aria-current="page"]');
    expect(current?.textContent).toBe('AI');
    await user.click(screen.getByRole('button', { name: 'Back to AI' }));
    expect(location.hash).toBe('#/ai');
    expect(await screen.findByRole('heading', { level: 1, name: 'AI' })).toBeTruthy();
  });
});

describe('Settings → AI: a source list that needs fixing', () => {
  it('test_ai_pane_shows_own_list_problems', async () => {
    // Synced in from two devices: two outlets (uuidv7 keys) with one web address. UnEcho Chamber can't use the list,
    // and the pane says why, naming the outlet, never its id.
    const user = setupUser();
    const DAILY = '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3e';
    const settings = defaultSettings();
    settings.perspectives.list = 'own';
    settings.perspectives.outlets = {
      '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d': { name: 'FX News', domains: ['fx-news.example'], bucket: 'center', addedAt: 1 },
      [DAILY]: { name: 'FX Daily', domains: ['fx-news.example'], bucket: 'right', addedAt: 2 },
    };
    const anthropic = device({ kind: 'anthropic', model: null });
    render(<AiPane settings={settings} save={vi.fn(async () => {})} device={anthropic} saveDevice={vi.fn(async () => {})} />);
    const title = "Your list needs fixing, so UnEcho Chamber can't use it.";
    const notice = within(screen.getByText(title).closest('.ua-banner') as HTMLElement);
    expect(notice.getByText('FX Daily: another outlet already lists one of its web addresses.')).toBeTruthy();
    expect(document.body.textContent).not.toContain(DAILY);
    await user.click(notice.getByRole('button', { name: 'Fix your list' }));
    expect(location.hash).toBe('#/ai/sources');
    cleanup();

    // The Cloud's list chosen: the own list's problem isn't this list's, so nothing is said.
    settings.perspectives.list = 'cloud';
    await officialListItem.setValue({ list: FIXTURE_OFFICIAL_LIST, checkedAt: 1 });
    render(<AiPane settings={settings} save={vi.fn(async () => {})} device={anthropic} saveDevice={vi.fn(async () => {})} />);
    expect(await screen.findByText('Version 1, 10 outlets with a lean')).toBeTruthy();
    expect(screen.queryByText(title)).toBeNull();
  });
});

describe('Settings navigation', () => {
  const sidebarItems = () =>
    [...screen.getByRole('navigation', { name: 'Settings' }).querySelectorAll('.sidebar-item:not(.sidebar-identity)')].map(
      (b) => b.textContent,
    );

  it('test_settings_has_no_labs_and_search_finds_ai', async () => {
    const user = setupUser();
    render(<App />);
    const search = await screen.findByRole('searchbox', { name: 'Search settings' });
    expect(sidebarItems()).toContain('AI');
    expect(sidebarItems()).not.toContain('Labs');
    await user.type(search, 'fact');
    expect(sidebarItems()).toEqual(['AI']);
  });

  it('test_labs_hash_opens_ai_pane', async () => {
    // Old links in docs, issues and bookmarks.
    location.hash = '#/labs';
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'AI' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Fact-check' })).toBeTruthy();
    const current = screen.getByRole('navigation', { name: 'Settings' }).querySelector('[aria-current="page"]');
    expect(current?.textContent).toBe('AI');
  });
});
