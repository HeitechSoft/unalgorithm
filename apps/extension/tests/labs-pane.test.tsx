/**
 * Settings → Labs (P3-05): the Fact-check switch works only with a source that can fact-check (an own Anthropic key in
 * RM1), writes the device-local `labs.factcheck` flag, and otherwise points to AI setup. Settings search finds the pane.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { type AISourceConfig, type Device, defaultDevice } from '@unalgorithm/core';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { App } from '../src/entrypoints/options/App.tsx';
import { LabsPane } from '../src/entrypoints/options/panes.tsx';
import { serverOfferItem } from '../src/lib/storage.ts';

vi.mock('../src/lib/messages.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/messages.ts')>()),
  sendToBackground: vi.fn(async () => undefined),
  sendQuietly: vi.fn(),
}));

const device = (aiSource: AISourceConfig | null): Device => ({ ...defaultDevice('dev1'), aiSource });

afterEach(() => {
  cleanup();
  location.hash = '';
  fakeBrowser.reset();
});

describe('Labs pane', () => {
  it('test_labs_pane_switch_saves_flag_for_anthropic', async () => {
    const user = setupUser();
    let stored = device({ kind: 'anthropic', model: null });
    const saveDevice = vi.fn(async (m: (d: Device) => void) => {
      const next = structuredClone(stored);
      m(next);
      stored = next;
    });
    render(<LabsPane device={stored} saveDevice={saveDevice} />);
    expect(screen.getByRole('heading', { name: 'Labs' })).toBeTruthy();
    expect(screen.getByText('Early features. They may change or go away.')).toBeTruthy();
    const sw = screen.getByRole('switch', { name: 'Fact-check' }) as HTMLButtonElement;
    expect(sw.disabled).toBe(false);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByText('Needs your own Anthropic key or a server that offers it.')).toBeNull();
    await user.click(sw);
    expect(saveDevice).toHaveBeenCalledTimes(1);
    expect(stored.labs.factcheck).toBe(true);
  });

  it('test_labs_pane_disabled_with_setup_link_without_capability', async () => {
    for (const source of [{ kind: 'openai', model: null } as const, null]) {
      const user = setupUser();
      const saveDevice = vi.fn(async () => {});
      // A flag stored earlier stays stored, but the switch shows off.
      const d = { ...device(source), labs: { factcheck: true, perspectives: false } };
      render(<LabsPane device={d} saveDevice={saveDevice} />);
      const sw = screen.getByRole('switch', { name: 'Fact-check' }) as HTMLButtonElement;
      expect(sw.disabled).toBe(true);
      expect(sw.getAttribute('aria-checked')).toBe('false');
      expect(screen.getByText('Needs your own Anthropic key or a server that offers it.')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Set up AI' }));
      expect(location.hash).toBe('#/ai');
      expect(saveDevice).not.toHaveBeenCalled();
      cleanup();
      location.hash = '';
    }
  });

  it('test_labs_pane_server_offer_enables_switch', async () => {
    const origin = 'https://unalgo.example';
    const d = device({ kind: 'server', baseUrl: origin });
    const saveDevice = vi.fn(async () => {});
    // No offer from the signed-in server: off, with the server's own reason.
    render(<LabsPane device={d} saveDevice={saveDevice} />);
    const off = screen.getByRole('switch', { name: 'Fact-check' }) as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    expect(screen.getByText("Your server doesn't offer fact-check.")).toBeTruthy();
    // The server starts offering it: the switch turns on live, without a reload (once the first read has settled).
    await act(async () => {});
    await serverOfferItem.setValue({
      origin,
      billing: false,
      factcheck: true,
      factcheckPrice: null,
      perspectives: false,
      perspectivesPrice: null,
    });
    await waitFor(() => expect((screen.getByRole('switch', { name: 'Fact-check' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("Your server doesn't offer fact-check.")).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set up AI' })).toBeNull();
    expect(screen.getByText(/with your own Anthropic key or your UnAlgorithm server/)).toBeTruthy();
  });

  it('test_settings_search_finds_labs', async () => {
    const user = setupUser();
    render(<App />);
    const search = await screen.findByRole('searchbox', { name: 'Search settings' });
    await user.type(search, 'fact');
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    const items = [...nav.querySelectorAll('.sidebar-item:not(.sidebar-identity)')].map((b) => b.textContent);
    expect(items).toEqual(['Labs']);
  });
});
