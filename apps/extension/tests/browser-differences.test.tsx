/**
 * What differs by browser outside the manifest (ADR 0008): the on-device card (hidden in Firefox, Edge's preview named
 * in Edge), the local server's Origin fix, the toolbar pin instructions, copy that names the browser, problem-report
 * diagnostics, content-script styles, and install-time injection. Vitest builds for Chrome, so `browserKind()` is
 * switched here; tests/browser-kind.test.ts covers how the real one decides.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { describeError } from '@unalgorithm/ai';
import { type AISourceConfig, type Device, defaultDevice, defaultSettings } from '@unalgorithm/core';
import type { PlatformAdapter } from '@unalgorithm/platforms';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { providerName } from '../src/background/ai.ts';
import { AiSetup } from '../src/components/AiSetup.tsx';
import type { Entry, FeedController } from '../src/content/feed-controller.ts';
import { reportProblemUrl } from '../src/content/report.ts';
import { mountUiHost } from '../src/content/ui-layer.tsx';
import background from '../src/entrypoints/background.ts';
import { App as Onboarding } from '../src/entrypoints/onboarding/App.tsx';
import { AiPane, PlatformPane, PrivacyPane } from '../src/entrypoints/options/panes.tsx';
import type { BrowserKind } from '../src/lib/browser-kind.ts';
import { type BgRequest, sendToBackground } from '../src/lib/messages.ts';
import { ORIGIN_RULE_ID } from '../src/lib/storage.ts';

const env = vi.hoisted(() => ({ kind: 'chrome' as BrowserKind }));
vi.mock('../src/lib/browser-kind.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/browser-kind.ts')>()),
  browserKind: () => env.kind,
}));
vi.mock('../src/lib/messages.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/messages.ts')>()),
  sendToBackground: vi.fn(),
}));

const KINDS: BrowserKind[] = ['chrome', 'edge', 'firefox'];
const FIREFOX_ORIGIN = 'moz-extension://0f8e43e4-77a1-4c69-9b2c-6f1d2f7d5a10';
const device = (aiSource: AISourceConfig | null = null): Device => ({ ...defaultDevice('dev1'), aiSource });
const onDeviceCard = () => screen.queryByRole('radio', { name: /^On this device/ });

let availability: 'no-api' | 'available' | 'downloadable';
let testReplies: Array<{ ok: boolean; error?: { code: string; message: string }; model?: string; latencyMs?: number }>;

beforeEach(() => {
  fakeBrowser.reset();
  env.kind = 'chrome';
  availability = 'no-api';
  testReplies = [];
  vi.mocked(sendToBackground).mockReset();
  vi.mocked(sendToBackground).mockImplementation((async (msg: BgRequest) => {
    if (msg.type === 'onDeviceStatus') return { availability };
    if (msg.type === 'testSource') return testReplies.shift();
    if (msg.type === 'saveSource') return { ok: true };
    return undefined;
  }) as never);
  vi.spyOn(fakeBrowser.permissions, 'getAll').mockResolvedValue({ origins: [], permissions: [] } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('on-device AI card', () => {
  it('test_on_device_card_names_the_browser', async () => {
    env.kind = 'chrome';
    const chrome = render(<AiSetup device={device()} />);
    await waitFor(() => expect((onDeviceCard() as HTMLInputElement).disabled).toBe(true));
    expect(screen.getByText(/^Not available on this computer\. Chrome's built-in AI needs a recent Chrome/)).toBeTruthy();
    chrome.unmount();

    env.kind = 'edge';
    const edge = render(<AiSetup device={device()} />);
    await waitFor(() => expect((onDeviceCard() as HTMLInputElement).disabled).toBe(true));
    const text = screen.getByText(/^Not available on this computer\. Edge's built-in AI is a preview/).textContent ?? '';
    for (const part of ['Edge Canary or Dev', 'edge://flags', 'Windows or macOS']) expect(text).toContain(part);
    expect(text).not.toContain('Chrome');
    edge.unmount();

    availability = 'available';
    render(<AiSetup device={device()} />);
    await waitFor(() => expect((onDeviceCard() as HTMLInputElement).disabled).toBe(false));
    expect(screen.getByText("Uses Edge's built-in AI, a preview. Posts never leave your computer.")).toBeTruthy();
  });

  it('test_firefox_has_no_on_device_card', async () => {
    env.kind = 'firefox';
    availability = 'available';
    render(<AiSetup device={device()} />);
    await screen.findByRole('radio', { name: /^Your own API key/ });
    expect(onDeviceCard()).toBeNull();
    expect(screen.queryByText(/built-in AI/)).toBeNull();
    for (const card of [/^Your own API key/, /^Local or self-hosted/, /^Off, rules only/])
      expect(screen.getByRole('radio', { name: card })).toBeTruthy();
  });

  it('test_provider_name_is_the_browser', () => {
    env.kind = 'chrome';
    expect(providerName({ kind: 'on-device' })).toBe('Chrome');
    env.kind = 'edge';
    expect(providerName({ kind: 'on-device' })).toBe('Edge');
    expect(describeError('overloaded', providerName({ kind: 'on-device' }))).toBe(
      'Edge is busy right now. unAlgorithm will try again shortly.',
    );
    expect(providerName({ kind: 'anthropic', model: null })).toBe('Anthropic');
  });
});

describe('local server Origin fix', () => {
  /** Tests Ollama, which refuses the extension's Origin, then clicks "Fix it for me". */
  async function fixIt() {
    const user = setupUser();
    testReplies = [
      { ok: false, error: { code: 'origin-blocked', message: describeError('origin-blocked') } },
      { ok: true, model: 'llama3.2', latencyMs: 300 },
    ];
    render(<AiSetup device={device()} />);
    await user.click(await screen.findByRole('radio', { name: /^Local or self-hosted/ }));
    await user.click(screen.getByRole('button', { name: 'Test and save' }));
    expect(await screen.findByText(/OLLAMA_ORIGINS=chrome-extension:\/\/\*,moz-extension:\/\/\* and restart it/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Fix it for me' }));
    await screen.findByText(/^Connected · llama3\.2/);
  }

  function stubPermissions() {
    const requested: unknown[] = [];
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation((async (p: unknown) => {
      requested.push(p);
      return true;
    }) as never);
    const contains = vi.spyOn(fakeBrowser.permissions, 'contains').mockResolvedValue(true as never);
    const rules = vi.spyOn(fakeBrowser.declarativeNetRequest, 'updateDynamicRules').mockResolvedValue(undefined as never);
    return { requested, contains, rules };
  }

  type Rules = { addRules: { id: number; condition: { initiatorDomains: string[] } }[] };
  const initiatorOf = (rules: ReturnType<typeof stubPermissions>['rules']) =>
    (rules.mock.calls[0]?.[0] as Rules | undefined)?.addRules[0];

  it('test_fix_local_origin_chromium', async () => {
    for (const kind of ['chrome', 'edge'] as const) {
      env.kind = kind;
      vi.spyOn(fakeBrowser.runtime, 'getURL').mockImplementation(
        (path: string) => `chrome-extension://aokmlebkpkeniofcnbeajmgabinicggm${path}` as never,
      );
      const { requested, contains, rules } = stubPermissions();
      await fixIt();
      // Asked for from the click, as an optional permission.
      expect(requested).toContainEqual({ permissions: ['declarativeNetRequestWithHostAccess'] });
      expect(contains).not.toHaveBeenCalled();
      const rule = initiatorOf(rules);
      expect(rule?.id).toBe(ORIGIN_RULE_ID);
      expect(rule?.condition.initiatorDomains).toEqual(['aokmlebkpkeniofcnbeajmgabinicggm']);
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('test_fix_local_origin_firefox', async () => {
    env.kind = 'firefox';
    vi.spyOn(fakeBrowser.runtime, 'getURL').mockImplementation((path: string) => `${FIREFOX_ORIGIN}${path}` as never);
    const { requested, contains, rules } = stubPermissions();
    await fixIt();
    // Firefox can't make the permission optional: it came with the install, so there is nothing to ask for.
    expect(requested).not.toContainEqual({ permissions: ['declarativeNetRequestWithHostAccess'] });
    expect(contains).toHaveBeenCalledWith({ permissions: ['declarativeNetRequestWithHostAccess'] });
    // The host of the extension's pages (Firefox's per-install UUID), never the add-on ID, which isn't a domain.
    expect(initiatorOf(rules)?.condition.initiatorDomains).toEqual(['0f8e43e4-77a1-4c69-9b2c-6f1d2f7d5a10']);
  });

  it('test_fix_local_origin_without_permission_or_rule', async () => {
    const user = setupUser();
    env.kind = 'firefox';
    vi.spyOn(fakeBrowser.permissions, 'request').mockResolvedValue(true as never);
    vi.spyOn(fakeBrowser.permissions, 'contains').mockResolvedValue(false as never);
    const rules = vi.spyOn(fakeBrowser.declarativeNetRequest, 'updateDynamicRules').mockResolvedValue(undefined as never);
    testReplies = [{ ok: false, error: { code: 'origin-blocked', message: describeError('origin-blocked') } }];
    render(<AiSetup device={device()} />);
    await user.click(await screen.findByRole('radio', { name: /^Local or self-hosted/ }));
    await user.click(screen.getByRole('button', { name: 'Test and save' }));
    await user.click(await screen.findByRole('button', { name: 'Fix it for me' }));
    // Nothing changes: the error still says how to set OLLAMA_ORIGINS by hand.
    expect(rules).not.toHaveBeenCalled();
    expect(screen.getByText(/OLLAMA_ORIGINS=.* and restart it/)).toBeTruthy();

    // A rule Firefox refuses doesn't escape as an unhandled rejection either.
    vi.mocked(fakeBrowser.permissions.contains).mockResolvedValue(true as never);
    rules.mockRejectedValue(new Error('Invalid domain'));
    await user.click(screen.getByRole('button', { name: 'Fix it for me' }));
    await waitFor(() => expect(rules).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/OLLAMA_ORIGINS=.* and restart it/)).toBeTruthy();
    expect(vi.mocked(sendToBackground).mock.calls.filter(([m]) => m.type === 'testSource')).toHaveLength(1);
  });
});

describe('onboarding pin card', () => {
  async function doneCard(isOnToolbar: boolean) {
    vi.spyOn(fakeBrowser.action, 'getUserSettings').mockResolvedValue({ isOnToolbar } as never);
    const user = setupUser();
    render(<Onboarding />);
    await user.click(await screen.findByRole('button', { name: 'Skip setup and use recommended settings' }));
    await screen.findByText("You're all set.");
  }

  it('test_pin_instructions_per_browser', async () => {
    const steps: Record<BrowserKind, string> = {
      chrome: 'Click the puzzle piece in Chrome’s toolbar, then the pin next to unAlgorithm. It shows how many posts are hidden.',
      edge: 'Click Extensions (the puzzle piece) in Edge’s toolbar, then Show in toolbar (the eye) next to unAlgorithm. It shows how many posts are hidden.',
      firefox:
        'Click Extensions (the puzzle piece) in Firefox’s toolbar, then the gear next to unAlgorithm and Pin to Toolbar. It shows how many posts are hidden.',
    };
    for (const kind of KINDS) {
      env.kind = kind;
      await doneCard(false);
      expect(await screen.findByText(steps[kind]), kind).toBeTruthy();
      expect(screen.getByText('Pin unAlgorithm to your toolbar')).toBeTruthy();
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('test_pinned_card_per_browser', async () => {
    // Firefox puts the button on the toolbar itself (`default_area`); Chrome and Edge only once the person pins it.
    for (const [kind, headline] of [
      ['chrome', 'Pinned to your toolbar'],
      ['edge', 'Pinned to your toolbar'],
      ['firefox', 'On your toolbar'],
    ] as const) {
      env.kind = kind;
      await doneCard(true);
      expect(await screen.findByText(headline), kind).toBeTruthy();
      expect(screen.getByText('You’ll see how many posts are hidden on each page.')).toBeTruthy();
      cleanup();
      vi.restoreAllMocks();
    }
  });
});

describe('settings copy', () => {
  const save = vi.fn(async () => {});

  it('test_ai_copy_without_on_device_in_firefox', () => {
    for (const [kind, subtitle, footer] of [
      [
        'chrome',
        'On-device, your own key, or a local model',
        'Applies to sources that cost money. Local and on-device AI are unlimited.',
      ],
      [
        'edge',
        'On-device, your own key, or a local model',
        'Applies to sources that cost money. Local and on-device AI are unlimited.',
      ],
      ['firefox', 'Your own key or a local model', 'Applies to sources that cost money. Local AI is unlimited.'],
    ] as const) {
      env.kind = kind;
      render(<PlatformPane platform="linkedin" settings={defaultSettings()} save={save} device={device()} />);
      expect(screen.getByText(subtitle), kind).toBeTruthy();
      cleanup();
      render(<AiPane settings={defaultSettings()} save={save} device={device()} saveDevice={save} />);
      expect(screen.getByText(footer), kind).toBeTruthy();
      cleanup();
    }
  });

  it('test_privacy_pane_names_the_built_in_ai', () => {
    for (const [kind, label] of [
      ['chrome', 'Chrome'],
      ['edge', 'Edge'],
    ] as const) {
      env.kind = kind;
      render(<PrivacyPane settings={defaultSettings()} device={device({ kind: 'on-device' })} />);
      expect(screen.getByText(`${label}'s built-in AI runs on this computer. Nothing leaves it.`), kind).toBeTruthy();
      cleanup();
    }
  });
});

describe('content scripts', () => {
  const entry = () => ({ el: document.createElement('div') }) as unknown as Entry;

  it('test_ui_styles_per_browser', () => {
    const style = (shadow: ShadowRoot) => shadow.querySelector('style');
    // Firefox: a <style> element, never an adopted sheet.
    class Sheet {
      replaceSync() {}
    }
    vi.stubGlobal('CSSStyleSheet', Sheet);
    env.kind = 'firefox';
    const firefox = mountUiHost(entry()).host.shadowRoot as ShadowRoot;
    expect(style(firefox)).not.toBeNull();
    expect(firefox.firstChild).toBe(style(firefox));
    expect(firefox.adoptedStyleSheets ?? []).toHaveLength(0);

    // Chrome and Edge fall back to the same <style> where a sheet can't be constructed...
    vi.stubGlobal(
      'CSSStyleSheet',
      class {
        constructor() {
          throw new TypeError('Illegal constructor');
        }
      },
    );
    env.kind = 'edge';
    const fallback = mountUiHost(entry()).host.shadowRoot as ShadowRoot;
    expect(style(fallback)).not.toBeNull();

    // ...and otherwise adopt one sheet, shared by every shadow root.
    vi.stubGlobal('CSSStyleSheet', Sheet);
    env.kind = 'chrome';
    const first = mountUiHost(entry()).host.shadowRoot as ShadowRoot;
    const second = mountUiHost(entry()).host.shadowRoot as ShadowRoot;
    expect(first.adoptedStyleSheets).toHaveLength(1);
    expect(first.adoptedStyleSheets[0]).toBeInstanceOf(Sheet);
    expect(second.adoptedStyleSheets[0]).toBe(first.adoptedStyleSheets[0]);
    expect(style(first)).toBeNull();
  });

  it('test_report_names_browser_and_major_version_only', () => {
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ version: '0.3.1' } as never);
    const adapter = { id: 'linkedin', version: 'linkedin@2026.10.1' } as PlatformAdapter;
    const controller = {
      diagnostics: () => ({ counts: {}, detectors: {}, landmarks: {} }),
      getHealth: () => ({ status: 'ok' }),
    } as unknown as FeedController;
    for (const [ua, expected] of [
      ['Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0', 'Firefox 147'],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.55 Safari/537.36 Edg/141.0.3537.57',
        'Edge 141',
      ],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.55 Safari/537.36',
        'Chrome 141',
      ],
    ]) {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua as string);
      const url = new URL(reportProblemUrl(adapter, controller));
      const diagnostics = JSON.parse(url.searchParams.get('diagnostics') ?? '{}') as Record<string, unknown>;
      expect(diagnostics.browser, ua).toBe(expected);
      expect(diagnostics).not.toHaveProperty('chrome');
      // No full version, platform or user agent string.
      expect(url.toString()).not.toMatch(/7390|3537|Win64|X11|Gecko/);
    }
  });

  it('test_install_injects_into_open_tabs_except_in_firefox', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    for (const kind of KINDS) {
      fakeBrowser.reset();
      env.kind = kind;
      vi.spyOn(fakeBrowser.sidePanel, 'setPanelBehavior').mockResolvedValue(undefined as never);
      const created = vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({} as never);
      vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([{ id: 7, url: 'https://www.linkedin.com/feed/' }] as never);
      const injected = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue([] as never);
      // Firefox's background also listens for data-collection consent (firefox-cloud.test.tsx).
      vi.spyOn(fakeBrowser.permissions.onAdded, 'addListener').mockImplementation(() => undefined);
      background.main();
      await fakeBrowser.runtime.onInstalled.trigger({ reason: 'install' } as never);
      expect(created, kind).toHaveBeenCalledWith({ url: expect.stringMatching(/\/onboarding\.html$/) });
      // Firefox puts the content scripts on open tabs itself.
      if (kind === 'firefox') expect(injected).not.toHaveBeenCalled();
      else expect(injected, kind).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ['/content-scripts/linkedin.js'] });
      vi.restoreAllMocks();
    }
  });
});
