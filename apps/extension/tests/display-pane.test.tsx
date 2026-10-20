/**
 * Settings → Display → *Group hidden posts in a row* (settings version 3): off by default, so each hidden post keeps
 * its own fold line, with Why? and Show. Turning it on is a setting like the rest of the pane: stored, stamped for sync,
 * and found by the sidebar's search.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { defaultSettings } from '@unalgorithm/core';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { App } from '../src/entrypoints/options/App.tsx';
import { GROUP_RUNS_COPY } from '../src/entrypoints/options/panes.tsx';
import { readSettings, settingsClocksItem, settingsItem } from '../src/lib/storage.ts';

vi.mock('../src/lib/messages.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/messages.ts')>()),
  sendToBackground: vi.fn(async () => undefined),
  sendQuietly: vi.fn(),
}));

afterEach(() => {
  cleanup();
  location.hash = '';
  fakeBrowser.reset();
});

const groupSwitch = () => screen.findByRole('switch', { name: GROUP_RUNS_COPY.title });

describe('Settings → Display: hidden posts in a row', () => {
  it('test_group_hidden_posts_is_off_by_default_and_saves', async () => {
    expect(GROUP_RUNS_COPY).toStrictEqual({
      title: 'Group hidden posts in a row',
      subtitle: 'Shows posts hidden one after another as one line with Show all',
    });
    const user = setupUser();
    location.hash = '#/display';
    render(<App />);
    const toggle = await groupSwitch();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(GROUP_RUNS_COPY.subtitle)).toBeTruthy();

    await user.click(toggle);
    await waitFor(async () => expect((await readSettings()).display.groupRuns).toBe(true));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    // Stamped like any other change, so sync carries it to the person's other computers.
    expect(Object.keys(await settingsClocksItem.getValue())).toStrictEqual(['display.groupRuns']);

    await user.click(toggle);
    await waitFor(async () => expect((await readSettings()).display.groupRuns).toBe(false));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  });

  it('test_settings_from_version_2_open_with_grouping_off', async () => {
    // Version 2's default, grouping on and never changed: shown as the new default.
    const v2 = defaultSettings();
    v2.display.groupRuns = true;
    await settingsItem.setValue({ ...v2, version: 2 });
    location.hash = '#/display';
    render(<App />);
    expect((await groupSwitch()).getAttribute('aria-checked')).toBe('false');
  });

  it('test_search_finds_the_switch', async () => {
    const user = setupUser();
    render(<App />);
    const search = await screen.findByRole('searchbox', { name: 'Search settings' });
    await user.type(search, 'show all');
    const items = [
      ...screen.getByRole('navigation', { name: 'Settings' }).querySelectorAll('.sidebar-item:not(.sidebar-identity)'),
    ].map((b) => b.textContent);
    expect(items).toStrictEqual(['Display']);
  });
});
