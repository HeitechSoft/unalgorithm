/**
 * The web search key for an OpenAI-compatible source (P3-45, F24): Settings → AI shows it for that source only and
 * asks for the provider's host permission from the Save click; the background tests the key with one fixed search
 * before storing it like an AI key, and only extension pages may save or forget it. Search is a stub: no real service.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AIError } from '@unalgorithm/ai';
import { type AISourceConfig, type Device, defaultDevice, defaultSettings, sourceId } from '@unalgorithm/core';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { clearSecrets, getSecret, setSecret } from '../src/background/idb.ts';
import { deviceSearchProvider } from '../src/background/search-key.ts';
import { handlers } from '../src/entrypoints/background.ts';
import { CheckSettings } from '../src/entrypoints/options/panes.tsx';
import { sendToBackground } from '../src/lib/messages.ts';
import { deviceItem, readDevice } from '../src/lib/storage.ts';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@unalgorithm/research', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@unalgorithm/research')>()),
  createSearchProvider: mocks.create,
}));

vi.mock('../src/lib/messages.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/messages.ts')>()),
  sendToBackground: vi.fn(async () => ({ ok: true })),
  sendQuietly: vi.fn(),
}));

type Sender = Browser.runtime.MessageSender;

const COMPAT: AISourceConfig = {
  kind: 'openai-compatible',
  preset: 'groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  auth: 'bearer',
  model: 'llama',
};
const BRAVE = 'https://api.search.brave.com/*';
const TAVILY = 'https://api.tavily.com/*';

const device = (aiSource: AISourceConfig | null, over: Partial<Device> = {}): Device => ({
  ...defaultDevice('dev1'),
  aiSource,
  ...over,
});

const tab = (id: number, url: string) => ({ id, url }) as Browser.tabs.Tab;
const page = (): Sender => ({
  tab: tab(3, fakeBrowser.runtime.getURL('/options.html')),
  url: fakeBrowser.runtime.getURL('/options.html'),
});
const feedTab = (): Sender => ({ tab: tab(7, 'https://www.linkedin.com/feed/'), url: 'https://www.linkedin.com/feed/' });

const permit = (granted: boolean) =>
  vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation((async () => granted) as never);

beforeEach(async () => {
  fakeBrowser.reset();
  await clearSecrets();
  mocks.search.mockReset().mockResolvedValue([]);
  mocks.create.mockReset().mockImplementation((cfg: { provider: string }) => ({ id: cfg.provider, search: mocks.search }));
  vi.mocked(sendToBackground)
    .mockReset()
    .mockResolvedValue({ ok: true } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Settings → AI', () => {
  it('test_labs_web_search_section_only_for_compat', () => {
    const others: Array<AISourceConfig | null> = [
      { kind: 'anthropic', model: null },
      { kind: 'openai', model: null },
      { kind: 'on-device' },
      { kind: 'server', baseUrl: 'https://unalgo.example' },
      null,
    ];
    for (const source of others) {
      render(
        <CheckSettings
          settings={defaultSettings()}
          save={vi.fn(async () => {})}
          device={device(source)}
          saveDevice={vi.fn(async () => {})}
        />,
      );
      expect(screen.queryByRole('heading', { name: 'Web search key' })).toBeNull();
      cleanup();
    }
    render(
      <CheckSettings
        settings={defaultSettings()}
        save={vi.fn(async () => {})}
        device={device(COMPAT)}
        saveDevice={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Web search key' })).toBeTruthy();
    expect(screen.getByText(/search the web with your own Brave or Tavily key/)).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Brave/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Tavily/ })).toBeTruthy();
  });

  it('test_save_requests_permission_from_click', async () => {
    const request = vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation((async () => true) as never);
    const user = setupUser();
    render(
      <CheckSettings
        settings={defaultSettings()}
        save={vi.fn(async () => {})}
        device={device(COMPAT)}
        saveDevice={vi.fn(async () => {})}
      />,
    );
    expect(request).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Brave API key'), ' brave-key ');
    // A synchronous click: the request must already have been made when the handler returns.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ origins: [BRAVE] });
    expect(sendToBackground).not.toHaveBeenCalled();
    expect(await screen.findByText('Connected · Brave')).toBeTruthy();
    expect(sendToBackground).toHaveBeenCalledWith({ type: 'saveSearchKey', provider: 'brave', apiKey: 'brave-key' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('test_permission_denied_sends_nothing', async () => {
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation((async () => false) as never);
    const user = setupUser();
    render(
      <CheckSettings
        settings={defaultSettings()}
        save={vi.fn(async () => {})}
        device={device(COMPAT)}
        saveDevice={vi.fn(async () => {})}
      />,
    );
    await user.click(screen.getByRole('radio', { name: /Tavily/ }));
    await user.type(screen.getByLabelText('Tavily API key'), 'tvly-key');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(
        "unAlgorithm needs permission to reach api.tavily.com. That's the only place your web search key and the search words go.",
      ),
    ).toBeTruthy();
    expect(fakeBrowser.permissions.request).toHaveBeenCalledWith({ origins: [TAVILY] });
    expect(sendToBackground).not.toHaveBeenCalled();
  });

  it('test_labs_switches_follow_search_key', async () => {
    const labs = { factcheck: true, perspectives: true };
    render(
      <CheckSettings
        settings={defaultSettings()}
        save={vi.fn(async () => {})}
        device={device(COMPAT, { labs })}
        saveDevice={vi.fn(async () => {})}
      />,
    );
    for (const name of ['Fact-check', 'UnEcho Chamber']) {
      const sw = screen.getByRole('switch', { name }) as HTMLButtonElement;
      expect(sw.disabled).toBe(true);
      expect(sw.getAttribute('aria-checked')).toBe('false');
    }
    expect(screen.getAllByText('Needs a web search key (above).')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Set up AI' })).toBeNull();
    cleanup();

    // With a key: enabled and on, and the section shows the saved key (never the key itself) with Remove.
    const user = setupUser();
    render(
      <CheckSettings
        settings={defaultSettings()}
        save={vi.fn(async () => {})}
        device={device(COMPAT, { labs, webSearch: { provider: 'brave' } })}
        saveDevice={vi.fn(async () => {})}
      />,
    );
    for (const name of ['Fact-check', 'UnEcho Chamber']) {
      const sw = screen.getByRole('switch', { name }) as HTMLButtonElement;
      expect(sw.disabled).toBe(false);
      expect(sw.getAttribute('aria-checked')).toBe('true');
    }
    expect(screen.queryByText('Needs a web search key (above).')).toBeNull();
    expect(screen.getByText('Brave key saved')).toBeTruthy();
    expect(screen.queryByLabelText('Brave API key')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(sendToBackground).toHaveBeenCalledWith({ type: 'forgetSearchKey' });
  });
});

describe('background', () => {
  it('test_save_search_key_tests_then_stores', async () => {
    permit(true);
    await deviceItem.setValue(device(COMPAT));
    await setSecret('search:tavily', 'old-tavily');
    expect(await handlers.saveSearchKey({ type: 'saveSearchKey', provider: 'brave', apiKey: ' k ' }, page())).toStrictEqual({
      ok: true,
    });
    expect(fakeBrowser.permissions.contains).toHaveBeenCalledWith({ origins: [BRAVE] });
    expect(mocks.create).toHaveBeenCalledWith({ provider: 'brave', apiKey: 'k' });
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search).toHaveBeenCalledWith('unAlgorithm', { count: 1 });
    expect(await getSecret('search:brave')).toBe('k');
    expect(await getSecret('search:tavily')).toBeUndefined();
    expect((await readDevice()).webSearch).toStrictEqual({ provider: 'brave' });
    // P3-46 searches on the stored key; none without the setting or the secret.
    mocks.create.mockClear();
    expect(await deviceSearchProvider(await readDevice())).not.toBeNull();
    expect(mocks.create).toHaveBeenCalledWith({ provider: 'brave', apiKey: 'k' });
    expect(await deviceSearchProvider({ webSearch: null })).toBeNull();
    expect(await deviceSearchProvider({ webSearch: { provider: 'tavily' } })).toBeNull();
  });

  it('test_save_search_key_refused_key_or_permission', async () => {
    permit(true);
    await deviceItem.setValue(device(COMPAT));
    mocks.search.mockRejectedValueOnce(new AIError('not-available', 'The search provider refused the request.'));
    expect(await handlers.saveSearchKey({ type: 'saveSearchKey', provider: 'brave', apiKey: 'k' }, page())).toStrictEqual({
      ok: false,
      error: { code: 'not-available', message: "Brave didn't accept this key." },
    });
    expect(await getSecret('search:brave')).toBeUndefined();
    expect((await readDevice()).webSearch).toBeNull();

    // The other fixed messages.
    mocks.search.mockRejectedValueOnce(new AIError('rate-limit', 'x'));
    expect(await handlers.saveSearchKey({ type: 'saveSearchKey', provider: 'tavily', apiKey: 'k' }, page())).toMatchObject({
      error: { message: 'Tavily is limiting searches right now. Try again in a minute.' },
    });
    mocks.search.mockRejectedValueOnce(new Error('boom'));
    expect(await handlers.saveSearchKey({ type: 'saveSearchKey', provider: 'brave', apiKey: 'k' }, page())).toMatchObject({
      error: { message: "Couldn't reach Brave. Try again." },
    });

    // No host permission: no search at all.
    mocks.search.mockClear();
    permit(false);
    expect(await handlers.saveSearchKey({ type: 'saveSearchKey', provider: 'brave', apiKey: 'k' }, page())).toStrictEqual({
      ok: false,
      error: { code: 'host-permission', message: 'unAlgorithm needs permission to reach api.search.brave.com.' },
    });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(await getSecret('search:brave')).toBeUndefined();
    expect((await readDevice()).webSearch).toBeNull();
  });

  it('test_save_search_key_bad_input', async () => {
    permit(true);
    const bad = [
      { provider: 'brave', apiKey: '' },
      { provider: 'brave', apiKey: '   ' },
      { provider: 'brave', apiKey: 'k'.repeat(201) },
      { provider: 'bing', apiKey: 'k' },
    ];
    for (const msg of bad) {
      expect(await handlers.saveSearchKey({ type: 'saveSearchKey', ...msg } as never, page())).toStrictEqual({
        ok: false,
        error: { code: 'bad-request', message: 'Enter the whole key.' },
      });
    }
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('test_forget_search_key', async () => {
    const remove = vi.spyOn(fakeBrowser.permissions, 'remove').mockImplementation((async () => true) as never);
    await deviceItem.setValue(device(COMPAT, { webSearch: { provider: 'brave' } }));
    await setSecret(sourceId(COMPAT), 'ai-key');
    await setSecret('search:brave', 'b');
    await setSecret('search:tavily', 't');
    expect(await handlers.forgetSearchKey({ type: 'forgetSearchKey' }, page())).toStrictEqual({ ok: true });
    expect(await getSecret('search:brave')).toBeUndefined();
    expect(await getSecret('search:tavily')).toBeUndefined();
    const after = await readDevice();
    expect(after.webSearch).toBeNull();
    expect(after.aiSource).toStrictEqual(COMPAT);
    expect(await getSecret(sourceId(COMPAT))).toBe('ai-key');
    expect(remove).toHaveBeenCalledWith({ origins: [BRAVE] });
    expect(remove).toHaveBeenCalledWith({ origins: [TAVILY] });

    // Removing a permission is best effort.
    remove.mockImplementation((async () => {
      throw new Error('nope');
    }) as never);
    expect(await handlers.forgetSearchKey({ type: 'forgetSearchKey' }, page())).toStrictEqual({ ok: true });
  });

  it('test_search_key_messages_extension_pages_only', async () => {
    permit(true);
    await deviceItem.setValue(device(COMPAT, { webSearch: { provider: 'tavily' } }));
    await setSecret('search:tavily', 't');
    await expect(handlers.saveSearchKey({ type: 'saveSearchKey', provider: 'brave', apiKey: 'k' }, feedTab())).rejects.toThrow(
      'not accepted',
    );
    await expect(handlers.forgetSearchKey({ type: 'forgetSearchKey' }, feedTab())).rejects.toThrow('not accepted');
    expect(mocks.search).not.toHaveBeenCalled();
    expect(await getSecret('search:tavily')).toBe('t');
    expect((await readDevice()).webSearch).toStrictEqual({ provider: 'tavily' });
  });
});
