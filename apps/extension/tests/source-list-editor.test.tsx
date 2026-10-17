/**
 * Your own source list for UnEcho Chamber (P3-76, decisions D100, D101, D110): Settings → AI → Edit your list. It starts
 * from a copy of UnAlgorithm Cloud's stored list (or the candidates while the Cloud has no lean), and the person adds,
 * edits and removes outlets and sets leans, with the balance warnings live. Every write is one `save` of
 * `perspectives.outlets`. Settings and the Cloud's stored copy live in the WXT fake browser; every outlet is fictional
 * (`.example`), and every lean here is a test's.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { defaultSettings, migrateSettings, type OwnOutlet, type Settings } from '@unalgorithm/core';
import { FIXTURE_OFFICIAL_LIST } from '@unalgorithm/outlets/testing';
import { type LeanBucket, MAX_LIST_OUTLETS } from '@unalgorithm/protocol';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { SourceListEditor } from '../src/components/SourceListEditor.tsx';
import { useSettings } from '../src/lib/hooks.ts';
import { officialListItem, settingsItem } from '../src/lib/storage.ts';

const AT = 1_760_000_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const own = (name: string, domain: string, bucket: LeanBucket | null): OwnOutlet => ({
  name,
  domains: [domain],
  bucket,
  addedAt: AT,
});

/** Stores settings whose own list is `outlets`. */
async function seed(outlets: Record<string, OwnOutlet>): Promise<void> {
  const s = defaultSettings();
  s.perspectives.outlets = outlets;
  await settingsItem.setValue(s);
}

async function stored(): Promise<Settings> {
  return migrateSettings(await settingsItem.getValue());
}

/** The editor on the live settings (as App renders it), counting each `save`. */
function Editor({ onSave }: { onSave: () => void }) {
  const [settings, save] = useSettings();
  if (!settings) return null;
  return (
    <SourceListEditor
      settings={settings}
      save={(mutate) => {
        onSave();
        return save(mutate);
      }}
    />
  );
}

async function renderEditor() {
  const saves = vi.fn();
  render(<Editor onSave={saves} />);
  await screen.findByRole('heading', { level: 1, name: 'Your source list' });
  return saves;
}

const addForm = () => within(screen.getByRole('form', { name: 'Add an outlet' }));
const addButton = () => addForm().getByRole('button', { name: 'Add' }) as HTMLButtonElement;
const shownRows = () =>
  screen.getAllByRole('combobox', { name: /^Lean of / }).map((s) => s.getAttribute('aria-label')?.replace('Lean of ', ''));

afterEach(() => {
  cleanup();
  fakeBrowser.reset();
});

describe('Your source list', () => {
  it('test_editor_starts_from_cloud_or_candidates', async () => {
    // A stored Cloud copy with a lean: one click copies its 10 outlets with their buckets, in one save.
    await officialListItem.setValue({ list: FIXTURE_OFFICIAL_LIST, checkedAt: AT });
    const user = setupUser();
    let saves = await renderEditor();
    expect(screen.getByText('Your list is empty.')).toBeTruthy();
    expect(screen.getByText(/This list is yours: no one reviews it\./)).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: "Start from UnAlgorithm Cloud's list" }));
    await waitFor(async () => expect(Object.keys((await stored()).perspectives.outlets)).toHaveLength(10));
    expect(saves).toHaveBeenCalledTimes(1);
    const fromCloud = (await stored()).perspectives.outlets;
    for (const o of FIXTURE_OFFICIAL_LIST.outlets) {
      expect(fromCloud[o.id]).toMatchObject({ name: o.name, domains: o.domains, bucket: o.lean?.bucket });
    }
    expect(JSON.stringify(fromCloud)).not.toContain('evidence');
    expect(await screen.findByText('Fixture Left A')).toBeTruthy();
    expect(screen.queryByText('Your list is empty.')).toBeNull();
    // Nothing but the own list is written.
    expect((await stored()).perspectives.list).toBe('cloud');
    cleanup();
    fakeBrowser.reset();

    // No stored copy: the candidates, with no lean, in one save.
    saves = await renderEditor();
    expect(screen.queryByRole('button', { name: "Start from UnAlgorithm Cloud's list" })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Start from the candidate list' }));
    await waitFor(async () => expect(Object.keys((await stored()).perspectives.outlets)).toHaveLength(169));
    expect(saves).toHaveBeenCalledTimes(1);
    for (const entry of Object.values((await stored()).perspectives.outlets)) expect(entry.bucket).toBeNull();
    // A list with no lean can't be used yet: the notice says so.
    expect(await screen.findByText("Your list has no outlets with a lean, so UnEcho Chamber can't use it.")).toBeTruthy();
  });

  it('test_editor_adds_outlet_and_refuses_bad_input', async () => {
    await seed({ 'fx-left-a': own('Fixture Left A', 'left-a.example', 'left') });
    const user = setupUser();
    let saves = await renderEditor();
    expect(addButton().disabled).toBe(true);

    await user.type(addForm().getByLabelText('Name'), 'FX News');
    expect(addButton().disabled).toBe(true);
    await user.type(addForm().getByLabelText('Web addresses'), 'https://www.fx-news.example/');
    await user.selectOptions(addForm().getByLabelText('Lean'), 'Center');
    expect(addButton().disabled).toBe(false);
    await user.click(addButton());
    await waitFor(async () => expect(Object.keys((await stored()).perspectives.outlets)).toHaveLength(2));
    expect(saves).toHaveBeenCalledTimes(1);
    const [id, added] = Object.entries((await stored()).perspectives.outlets).find(([key]) => key !== 'fx-left-a') ?? [];
    expect(id).toMatch(UUID);
    expect(added).toMatchObject({ name: 'FX News', domains: ['fx-news.example'], bucket: 'center' });
    // The form is empty again for the next outlet.
    await waitFor(() => expect((addForm().getByLabelText('Name') as HTMLInputElement).value).toBe(''));
    expect((addForm().getByLabelText('Web addresses') as HTMLInputElement).value).toBe('');
    const form = addForm();

    // Not a web address: said once the field is left; Add stays off.
    await user.type(form.getByLabelText('Name'), 'FX Other');
    await user.type(form.getByLabelText('Web addresses'), 'not a site');
    await user.tab();
    expect(form.getByText('Not a web address: not a site')).toBeTruthy();
    expect(addButton().disabled).toBe(true);

    // An address another outlet lists, or one inside another outlet's: that problem's words.
    await user.clear(form.getByLabelText('Web addresses'));
    await user.type(form.getByLabelText('Web addresses'), 'left-a.example');
    expect(form.getByText('FX Other: another outlet already lists one of its web addresses.')).toBeTruthy();
    expect(addButton().disabled).toBe(true);
    await user.clear(form.getByLabelText('Web addresses'));
    await user.type(form.getByLabelText('Web addresses'), 'news.left-a.example');
    expect(form.getByText("FX Other: one of its web addresses is inside another outlet's.")).toBeTruthy();
    expect(addButton().disabled).toBe(true);
    await user.click(addButton());
    expect(saves).toHaveBeenCalledTimes(1);
    expect(Object.keys((await stored()).perspectives.outlets)).toHaveLength(2);
    cleanup();

    // At MAX_LIST_OUTLETS: the limit sentence, and Add stays off even for a sound outlet.
    await seed(
      Object.fromEntries(
        Array.from({ length: MAX_LIST_OUTLETS }, (_, i) => [`fx-${i}`, own(`Fixture ${i}`, `outlet-${i}.example`, null)]),
      ),
    );
    saves = await renderEditor();
    expect(addForm().getByText('Your list has 300 outlets, the most it can hold.')).toBeTruthy();
    await user.type(addForm().getByLabelText('Name'), 'FX One More');
    await user.type(addForm().getByLabelText('Web addresses'), 'one-more.example');
    expect(addButton().disabled).toBe(true);
    await user.click(addButton());
    expect(saves).not.toHaveBeenCalled();
    expect(Object.keys((await stored()).perspectives.outlets)).toHaveLength(MAX_LIST_OUTLETS);
  });

  it('test_editor_changes_lean_edits_and_removes', async () => {
    await seed({
      'fx-alpha': own('FX Alpha', 'alpha.example', 'left'),
      'fx-beta': own('FX Beta', 'beta.example', null),
    });
    const user = setupUser();
    const saves = await renderEditor();
    // Rows are sorted by name.
    expect(shownRows()).toEqual(['FX Alpha', 'FX Beta']);

    // The row's lean saves on change: that one entry's bucket.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Lean of FX Beta' }), 'Right');
    await waitFor(async () => expect((await stored()).perspectives.outlets['fx-beta']?.bucket).toBe('right'));
    expect(saves).toHaveBeenCalledTimes(1);
    expect((await stored()).perspectives.outlets['fx-alpha']).toStrictEqual(own('FX Alpha', 'alpha.example', 'left'));

    // Edit: the same form, filled, in place of the row.
    await user.click(screen.getByRole('button', { name: 'Edit FX Alpha' }));
    const edit = within(screen.getByRole('form', { name: 'Edit FX Alpha' }));
    expect((edit.getByLabelText('Name') as HTMLInputElement).value).toBe('FX Alpha');
    expect((edit.getByLabelText('Web addresses') as HTMLInputElement).value).toBe('alpha.example');
    await user.clear(edit.getByLabelText('Web addresses'));
    await user.type(edit.getByLabelText('Web addresses'), 'alpha.example, https://alpha-news.example/today');
    await user.click(edit.getByRole('button', { name: 'Save' }));
    await waitFor(async () =>
      expect((await stored()).perspectives.outlets['fx-alpha']).toStrictEqual({
        ...own('FX Alpha', 'alpha.example', 'left'),
        domains: ['alpha.example', 'alpha-news.example'],
      }),
    );
    expect(saves).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('form', { name: 'Edit FX Alpha' })).toBeNull();

    // Remove: the entry goes, with no undo.
    await user.click(screen.getByRole('button', { name: 'Remove FX Beta' }));
    await waitFor(async () => expect(Object.keys((await stored()).perspectives.outlets)).toEqual(['fx-alpha']));
    expect(saves).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(shownRows()).toEqual(['FX Alpha']));
  });

  it('test_editor_filter', async () => {
    await seed({
      'fx-news': own('FX News', 'fx-news.example', 'center'),
      'fx-alpha': own('FX Alpha', 'alpha.example', 'left'),
      'fx-northern': own('FX Northern', 'northern.example', 'right'),
    });
    const user = setupUser();
    await renderEditor();
    expect(shownRows()).toEqual(['FX Alpha', 'FX News', 'FX Northern']);
    // Name or web address, any letter case.
    await user.type(screen.getByRole('searchbox', { name: 'Find an outlet' }), 'FX-N');
    expect(shownRows()).toEqual(['FX News']);
    await user.clear(screen.getByRole('searchbox', { name: 'Find an outlet' }));
    await user.type(screen.getByRole('searchbox', { name: 'Find an outlet' }), 'north');
    expect(shownRows()).toEqual(['FX Northern']);
  });

  it('test_editor_balance_notice_live', async () => {
    // Two outlets in every bucket but Right.
    await seed(
      Object.fromEntries(
        (['left', 'lean-left', 'center', 'lean-right'] as const).flatMap((bucket) =>
          (['a', 'b'] as const).map((s) => [
            `fx-${bucket}-${s}`,
            own(`Fixture ${bucket} ${s}`, `${bucket}-${s}.example`, bucket),
          ]),
        ),
      ),
    );
    const user = setupUser();
    await renderEditor();
    expect(screen.getByText("Your list isn't balanced")).toBeTruthy();
    expect(screen.getByText('No outlets in Right.')).toBeTruthy();

    const add = async (name: string, address: string) => {
      await user.type(addForm().getByLabelText('Name'), name);
      await user.type(addForm().getByLabelText('Web addresses'), address);
      await user.selectOptions(addForm().getByLabelText('Lean'), 'Right');
      await user.click(addButton());
      // Saved: the form empties for the next one.
      await waitFor(() => expect((addForm().getByLabelText('Name') as HTMLInputElement).value).toBe(''));
    };
    await add('Fixture Right A', 'right-a.example');
    expect(await screen.findByText('Only 1 outlet in Right.')).toBeTruthy();
    expect(screen.queryByText('No outlets in Right.')).toBeNull();
    await add('Fixture Right B', 'right-b.example');
    await waitFor(() => expect(screen.queryByText("Your list isn't balanced")).toBeNull());
    expect(screen.queryByText(/in Right\./)).toBeNull();
  });
});
