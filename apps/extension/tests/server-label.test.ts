/**
 * Server naming (R25): only HeitechSoft's pinned origin is ever called "unAlgorithm Cloud", every other server
 * appears by its host, and the recipient text names who actually receives posts. The screens are rendered with the
 * WXT fake browser; the APIs it leaves unmocked (permissions, the toolbar pin check) are stubbed per test.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type AISourceConfig, type Device, defaultDevice, defaultSettings } from '@unalgorithm/core';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { App as Onboarding } from '../src/entrypoints/onboarding/App.tsx';
import { PrivacyPane } from '../src/entrypoints/options/panes.tsx';
import { PINNED_CLOUD_ORIGIN, recipientText, serverLabel } from '../src/lib/server-label.ts';
import { deviceItem } from '../src/lib/storage.ts';

const cp = String.fromCodePoint;
const NEVER_SENT =
  "Author names, emails and phone numbers are never sent, and Facebook posts that aren't public stay on this computer.";

describe('naming', () => {
  it('test_pinned_origin_is_cloud', () => {
    const cloud = { title: 'unAlgorithm Cloud', host: 'cloud.unalgorithm.app', isCloud: true };
    expect(serverLabel('https://cloud.unalgorithm.app')).toStrictEqual(cloud);
    expect(serverLabel('https://cloud.unalgorithm.app/v1')).toStrictEqual(cloud);
    expect(serverLabel(PINNED_CLOUD_ORIGIN, { name: 'unAlgorithm Cloud' })).toStrictEqual(cloud);
  });

  it('test_lookalike_origins_are_not_cloud', () => {
    for (const [url, host] of [
      ['http://cloud.unalgorithm.app', 'cloud.unalgorithm.app'],
      ['https://cloud.unalgorithm.app.evil.org', 'cloud.unalgorithm.app.evil.org'],
      ['https://x.cloud.unalgorithm.app', 'x.cloud.unalgorithm.app'],
      ['https://cloud.unalgorithm.app:8443', 'cloud.unalgorithm.app:8443'],
      ['https://beta.unalgorithm.app', 'beta.unalgorithm.app'],
    ] as const) {
      expect(serverLabel(url), url).toStrictEqual({ title: host, host, isCloud: false });
    }
    expect(serverLabel('not a url')).toStrictEqual({ title: 'Your server', host: '', isCloud: false });
  });

  it('test_other_server_title_is_host_with_name', () => {
    expect(serverLabel('http://127.0.0.1:8787', { name: 'Family AI' })).toStrictEqual({
      title: '127.0.0.1:8787',
      host: '127.0.0.1:8787',
      isCloud: false,
      serverName: 'Family AI',
    });
    // Normalized like post text, trimmed and cut to 80 characters; a name that only repeats the host is dropped.
    expect(serverLabel('https://ai.example.org', { name: '  ‮Family​ AI  ' }).serverName).toBe('Family AI');
    expect(serverLabel('https://ai.example.org', { name: 'x'.repeat(120) }).serverName).toBe('x'.repeat(80));
    // The cut counts code points: an emoji that crosses it is dropped whole, never left as half a surrogate pair.
    expect(serverLabel('https://ai.example.org', { name: `${'x'.repeat(79)}😀😀` }).serverName).toBe(`${'x'.repeat(79)}😀`);
    expect(serverLabel('https://ai.example.org', { name: `${'x'.repeat(80)}😀` }).serverName).toBe('x'.repeat(80));
    expect(serverLabel('https://ai.example.org', { name: 'ai.example.org' })).not.toHaveProperty('serverName');
  });

  it('test_server_cannot_borrow_cloud_name', () => {
    for (const name of ['unAlgorithm Cloud', 'unalgorithm  cloud', 'unAlgo​rithm Cloud']) {
      const label = serverLabel('https://ai.example.org', { name });
      expect(label, name).toStrictEqual({ title: 'ai.example.org', host: 'ai.example.org', isCloud: false });
    }
    for (const name of [
      // Look-alike letters, written as code points so they can be told apart here: Cyrillic i, Cyrillic o, Greek and
      // Lisu capitals, all Lisu; then accents, a capital I for l, and "rn" for m.
      `unAlgor${cp(0x0456)}thm Cloud`,
      `UnAlg${cp(0x043e)}rithm Cl${cp(0x043e)}ud`,
      `UNALG${cp(0x039f)}RITHM ${cp(0xa4da)}L${cp(0x039f)}UD`,
      `${cp(0xa4f4, 0xa4e0, 0xa4ee, 0xa4e1, 0xa4d6, 0xa4f3, 0xa4e3, 0xa4f2, 0xa4d4, 0xa4e7, 0xa4df)} ${cp(0xa4da, 0xa4e1, 0xa4f3, 0xa4f4, 0xa4d3)}`,
      'ÜnÀlgorithm Clöud',
      'UnAIgorithm Cloud',
      'unAlgorithrn Cloud',
      // The Cloud's host, or both words in any order.
      'cloud.unalgorithm.app',
      'Cloud by unAlgorithm',
    ]) {
      expect(serverLabel('https://evil.org', { name }), name).toStrictEqual({
        title: 'evil.org',
        host: 'evil.org',
        isCloud: false,
      });
    }
    // Names in other alphabets, or with only one of the two words, are still shown.
    for (const name of ['Семейный AI', 'Ψηφιακό σύννεφο', 'unAlgorithm at home', 'Family Cloud']) {
      expect(serverLabel('https://ai.example.org', { name }).serverName, name).toBe(name);
    }
  });
});

describe('recipient text', () => {
  it('test_cloud_recipient_text', () => {
    const r = recipientText(serverLabel(PINNED_CLOUD_ORIGIN));
    expect(r.to).toBe('unAlgorithm Cloud');
    for (const s of ['unAlgorithm Cloud', 'HeitechSoft', 'Anthropic', 'United States']) expect(r.text).toContain(s);
    expect(r.text).not.toContain('Nothing is logged or kept');
    expect(r.text).not.toMatch(/zero/i);
    expect(r.text).toContain(NEVER_SENT);
  });

  it('test_self_hosted_recipient_text', () => {
    const r = recipientText(serverLabel('https://ai.example.org', { name: 'unAlgorithm Cloud' }));
    expect(r.to).toBe('ai.example.org');
    expect(r.text).toContain('ai.example.org');
    expect(r.text).toContain('not HeitechSoft');
    expect(r.text).not.toContain('unAlgorithm Cloud');
    expect(r.text).not.toContain('Anthropic');
    expect(r.text).toContain(NEVER_SENT);
  });
});

describe('screens', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    // `as never`: spyOn picks the callback overload, typed as returning void.
    vi.spyOn(fakeBrowser.permissions, 'getAll').mockResolvedValue({ origins: [], permissions: [] } as never);
    vi.spyOn(fakeBrowser.action, 'getUserSettings').mockResolvedValue({ isOnToolbar: true } as never);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const device = (aiSource: AISourceConfig): Device => ({ ...defaultDevice('dev1'), aiSource });

  it('test_privacy_pane_server_flow', () => {
    render(
      createElement(PrivacyPane, {
        settings: defaultSettings(),
        device: device({ kind: 'server', baseUrl: 'https://ai.example.org' }),
      }),
    );
    expect(screen.getByText('ai.example.org')).toBeTruthy();
    expect(
      screen.getByText(/^Post text goes from your browser to ai\.example\.org\. That server is run by its owner/),
    ).toBeTruthy();
    expect(screen.queryByText(/straight to OpenAI/)).toBeNull();
    expect(screen.queryByText('Remove saved API key')).toBeNull();
    expect(screen.getByText('No analytics. No tracking.')).toBeTruthy();
    expect(screen.queryByText(/No account/)).toBeNull();
  });

  it('test_privacy_pane_anthropic_flow_unchanged', () => {
    render(createElement(PrivacyPane, { settings: defaultSettings(), device: device({ kind: 'anthropic', model: null }) }));
    expect(screen.getByText('Anthropic')).toBeTruthy();
    expect(
      screen.getByText(
        'Post text goes from your browser straight to Anthropic. HeitechSoft never sees it. Author names, emails and phone numbers are never sent.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Remove saved API key')).toBeTruthy();
    expect(screen.getByText('No analytics. No tracking. No account.')).toBeTruthy();
  });

  it('test_onboarding_done_server_label', async () => {
    for (const [baseUrl, shown] of [
      [PINNED_CLOUD_ORIGIN, 'AI from unAlgorithm Cloud'],
      ['https://ai.example.org', 'AI from ai.example.org'],
    ] as const) {
      await deviceItem.setValue(device({ kind: 'server', baseUrl }));
      render(createElement(Onboarding));
      fireEvent.click(await screen.findByRole('button', { name: 'Skip setup and use recommended settings' }));
      expect(await screen.findByText((text) => text.includes(`· ${shown} ·`))).toBeTruthy();
      expect(screen.queryByText(/AI with your key/)).toBeNull();
      cleanup();
    }
  });
});
