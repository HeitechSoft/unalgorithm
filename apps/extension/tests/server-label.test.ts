/**
 * Server naming (R25): only HeitechSoft's pinned origin is ever called "UnAlgorithm Cloud", every other server
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

const NEVER_SENT =
  "Author names, emails and phone numbers are never sent, and Facebook posts that aren't public stay on this computer.";

describe('naming', () => {
  it('test_pinned_origin_is_cloud', () => {
    const cloud = { title: 'UnAlgorithm Cloud', host: 'cloud.unalgorithm.app', isCloud: true };
    expect(serverLabel('https://cloud.unalgorithm.app')).toStrictEqual(cloud);
    expect(serverLabel('https://cloud.unalgorithm.app/v1')).toStrictEqual(cloud);
    expect(serverLabel(PINNED_CLOUD_ORIGIN, { name: 'UnAlgorithm Cloud' })).toStrictEqual(cloud);
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
    expect(serverLabel('https://ai.example.org', { name: 'ai.example.org' })).not.toHaveProperty('serverName');
  });

  it('test_server_cannot_borrow_cloud_name', () => {
    for (const name of ['UnAlgorithm Cloud', 'unalgorithm  cloud', 'UnAlgo​rithm Cloud']) {
      const label = serverLabel('https://ai.example.org', { name });
      expect(label, name).toStrictEqual({ title: 'ai.example.org', host: 'ai.example.org', isCloud: false });
    }
  });
});

describe('recipient text', () => {
  it('test_cloud_recipient_text', () => {
    const r = recipientText(serverLabel(PINNED_CLOUD_ORIGIN));
    expect(r.to).toBe('UnAlgorithm Cloud');
    for (const s of ['UnAlgorithm Cloud', 'HeitechSoft', 'Anthropic', 'United States']) expect(r.text).toContain(s);
    expect(r.text).not.toContain('Nothing is logged or kept');
    expect(r.text).not.toMatch(/zero/i);
    expect(r.text).toContain(NEVER_SENT);
  });

  it('test_self_hosted_recipient_text', () => {
    const r = recipientText(serverLabel('https://ai.example.org', { name: 'UnAlgorithm Cloud' }));
    expect(r.to).toBe('ai.example.org');
    expect(r.text).toContain('ai.example.org');
    expect(r.text).toContain('not HeitechSoft');
    expect(r.text).not.toContain('UnAlgorithm Cloud');
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
      [PINNED_CLOUD_ORIGIN, 'AI from UnAlgorithm Cloud'],
      ['https://ai.example.org', 'AI from ai.example.org'],
    ] as const) {
      await deviceItem.setValue(device({ kind: 'server', baseUrl }));
      render(createElement(Onboarding));
      fireEvent.click(await screen.findByRole('button', { name: 'Skip setup and use recommended settings' }));
      expect(await screen.findByText(new RegExp(`· ${shown.replaceAll('.', '\\.')} ·`))).toBeTruthy();
      expect(screen.queryByText(/AI with your key/)).toBeNull();
      cleanup();
    }
  });
});
