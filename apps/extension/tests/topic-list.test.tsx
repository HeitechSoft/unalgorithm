/**
 * Topics in one list (components/TopicList.tsx): every starter topic and the person's own, each marked More, Less or
 * neither, in Settings → Interests and onboarding's interests step. A mark writes `interests.more.<id>` or
 * `interests.less.<id>` and takes the topic out of the other list; pressing the pressed button clears it; an own topic
 * exists only while it's marked. Settings live in the WXT fake browser, through the real store, so each mark is stamped
 * for sync under the keys the two lists always had.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import {
  defaultSettings,
  migrateSettings,
  type Settings,
  STARTER_LESS_OF,
  STARTER_TOPICS,
  settingsItemKey,
  type Topic,
} from '@unalgorithm/core';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  markedCount,
  markOf,
  markTopic,
  TOPIC_COPY,
  TopicList,
  topicCatalog,
  topicSummary,
} from '../src/components/TopicList.tsx';
import { App as Onboarding } from '../src/entrypoints/onboarding/App.tsx';
import { InterestsPane } from '../src/entrypoints/options/panes.tsx';
import { useSettings } from '../src/lib/hooks.ts';
import { settingsClocksItem, settingsItem } from '../src/lib/storage.ts';

vi.mock('../src/lib/messages.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/messages.ts')>()),
  sendToBackground: vi.fn(async () => undefined),
  sendQuietly: vi.fn(),
}));

const AT = 1_760_000_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STARTERS = [...STARTER_TOPICS, ...STARTER_LESS_OF];
const POLITICS = STARTER_LESS_OF.find((t) => t.id === 'politics');
const topic = (label: string, keywords = [label], addedAt = AT): Topic => ({ label, keywords, addedAt });

async function seed(interests: Partial<Settings['interests']>): Promise<void> {
  const s = defaultSettings();
  s.interests = { ...s.interests, ...interests };
  await settingsItem.setValue(s);
}

async function stored(): Promise<Settings['interests']> {
  return migrateSettings(await settingsItem.getValue()).interests;
}

/** The list on the live settings, as Settings and onboarding render it. */
function Live(props: { intro?: boolean; limit?: number; header?: string }) {
  const [settings, save] = useSettings();
  if (!settings) return null;
  return <TopicList interests={settings.interests} save={save} {...props} />;
}

async function renderList(props: { intro?: boolean; limit?: number; header?: string } = {}) {
  const user = setupUser();
  render(<Live {...props} />);
  await screen.findByRole('group', { name: 'AI & tech' });
  return user;
}

const more = (label: string) => screen.getByRole('button', { name: `More: ${label}` });
const less = (label: string) => screen.getByRole('button', { name: `Less: ${label}` });
const pressed = (b: HTMLElement) => b.getAttribute('aria-pressed');
const rows = () => screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));
const summary = () => document.querySelector('.topics-summary')?.textContent;

afterEach(() => {
  cleanup();
  fakeBrowser.reset();
});

describe('topics: the list and its marks', () => {
  it('test_catalog_is_every_starter_topic_once_then_own_topics', () => {
    const interests = defaultSettings().interests;
    expect(topicCatalog(interests).map((t) => t.id)).toEqual(STARTERS.map((t) => t.id));
    interests.more.b = topic('Beekeeping', ['bees'], AT + 1);
    interests.less.a = topic('Supply chain', ['supply chain'], AT);
    interests.more.politics = topic('Politics');
    const catalog = topicCatalog(interests);
    expect(catalog.map((t) => t.id)).toEqual([...STARTERS.map((t) => t.id), 'a', 'b']);
    expect(catalog.filter((t) => t.own).map((t) => t.label)).toEqual(['Supply chain', 'Beekeeping']);
    expect(catalog.map((t) => t.ids)).toEqual(catalog.map((t) => [t.id]));
  });

  it('test_an_own_topic_named_like_a_listed_one_is_that_row', () => {
    // Politics couldn't be picked under the old "More of", so people typed it; and an own name typed twice.
    const interests = defaultSettings().interests;
    interests.more['0190a0b0-0000-7000-8000-000000000001'] = topic('Politics', ['politics'], AT + 2);
    interests.less['custom-1700000000000'] = topic(' ai  &  TECH ', ['ai'], AT + 3);
    interests.more.g1 = topic('Gardening', ['gardening'], AT);
    interests.less.g2 = topic('gardening', ['garden'], AT + 1);
    const catalog = topicCatalog(interests);
    expect(catalog.map((t) => t.label)).toEqual([...STARTERS.map((t) => t.label), 'Gardening']);
    const row = (label: string) => {
      const t = catalog.find((c) => c.label === label);
      if (!t) throw new Error(`${label} is listed`);
      return t;
    };
    expect(row('Politics')).toMatchObject({
      id: 'politics',
      own: false,
      ids: ['politics', '0190a0b0-0000-7000-8000-000000000001'],
    });
    expect(row('AI & tech')).toMatchObject({ id: 'ai-tech', own: false, ids: ['ai-tech', 'custom-1700000000000'] });
    expect(row('Gardening')).toMatchObject({ id: 'g1', own: true, ids: ['g1', 'g2'] });
    expect([markOf(interests, row('Politics')), markOf(interests, row('AI & tech'))]).toEqual(['more', 'less']);
    // Stored twice, More and Less: one topic, shown as More until it's marked again.
    expect(markOf(interests, row('Gardening'))).toBe('more');
    expect(markedCount(interests)).toBe(3);
    expect(topicSummary(interests)).toBe('More: Politics, Gardening · Less: AI & tech');

    // Marking the row clears every id it stands for; a starter row's mark goes under the starter's id.
    const s = defaultSettings();
    s.interests = interests;
    markTopic(s, row('Politics'), 'less', AT + 9);
    markTopic(s, row('AI & tech'), null);
    markTopic(s, row('Gardening'), 'less');
    expect(s.interests.more).toEqual({});
    expect(s.interests.less).toEqual({
      politics: { label: 'Politics', keywords: POLITICS?.keywords, addedAt: AT + 9 },
      g1: topic('Gardening', ['gardening'], AT),
    });
  });

  it('test_mark_writes_one_list_and_clears_the_other', () => {
    const s = defaultSettings();
    const politics = topicCatalog(s.interests).find((t) => t.id === 'politics');
    if (!politics) throw new Error('Politics is a starter topic');
    markTopic(s, politics, 'more', AT);
    expect(s.interests.more.politics).toEqual({ label: 'Politics', keywords: POLITICS?.keywords, addedAt: AT });
    expect(s.interests.less.politics).toBeUndefined();
    markTopic(s, politics, 'less', AT + 1);
    expect(s.interests.more.politics).toBeUndefined();
    expect(s.interests.less.politics).toEqual({ label: 'Politics', keywords: POLITICS?.keywords, addedAt: AT + 1 });
    markTopic(s, politics, null);
    expect(markOf(s.interests, politics)).toBeNull();
    expect(s.interests.more).toEqual({});
    expect(s.interests.less).toEqual({});
  });

  it('test_summary_and_count', () => {
    const interests = defaultSettings().interests;
    expect(topicSummary(interests)).toBe('More: none · Less: none');
    expect(markedCount(interests)).toBe(0);
    interests.more.politics = topic('Politics');
    interests.more['ai-tech'] = topic('AI & tech');
    interests.less.crypto = topic('Crypto & get-rich-quick');
    // List order, not the order they were marked in.
    expect(topicSummary(interests)).toBe('More: AI & tech, Politics · Less: Crypto & get-rich-quick');
    expect(markedCount(interests)).toBe(3);
    // A topic in both lists (two devices at once) counts once, and as More.
    interests.less.politics = topic('Politics');
    expect(markedCount(interests)).toBe(3);
    expect(markOf(interests, { ids: ['politics'] })).toBe('more');
  });
});

describe('topics: the list on the page', () => {
  it('test_each_topic_is_a_group_with_more_and_less_toggles', async () => {
    await renderList({ header: 'Topics', intro: true });
    expect(rows()).toEqual(STARTERS.map((t) => t.label));
    for (const t of STARTERS) {
      const row = screen.getByRole('group', { name: t.label });
      const buttons = within(row).getAllByRole('button');
      expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([`More: ${t.label}`, `Less: ${t.label}`]);
      expect(buttons.map((b) => [b.textContent, pressed(b)])).toEqual([
        ['More', 'false'],
        ['Less', 'false'],
      ]);
    }
    expect(screen.getByRole('heading', { level: 3, name: 'Topics' })).toBeTruthy();
    expect(screen.getByText(TOPIC_COPY.intro)).toBeTruthy();
    expect(summary()).toBe('More: none · Less: none');
    expect(screen.getByText(TOPIC_COPY.footer)).toBeTruthy();
    expect(TOPIC_COPY).toMatchObject({
      intro: 'Mark any topic as more or less. Topics you leave alone change nothing.',
      footer: 'More: posts get a quiet For you highlight. Less: posts are folded away, even without AI.',
      add: 'Add your own topic, like Supply chain',
    });
    expect(screen.getByRole('textbox', { name: 'Add your own topic, like Supply chain' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: TOPIC_COPY.showAll })).toBeNull();
  });

  it('test_politics_can_be_more', async () => {
    const user = await renderList();
    await user.click(more('Politics'));
    await waitFor(() => expect(pressed(more('Politics'))).toBe('true'));
    expect(pressed(less('Politics'))).toBe('false');
    expect(summary()).toBe('More: Politics · Less: none');
    const interests = await stored();
    expect(interests.more.politics).toMatchObject({ label: 'Politics', keywords: POLITICS?.keywords });
    expect(interests.less).toEqual({});
  });

  it('test_more_and_less_are_never_both', async () => {
    const user = await renderList();
    await user.click(more('AI & tech'));
    await waitFor(() => expect(pressed(more('AI & tech'))).toBe('true'));
    await user.click(less('AI & tech'));
    await waitFor(() => expect(pressed(less('AI & tech'))).toBe('true'));
    expect(pressed(more('AI & tech'))).toBe('false');
    expect(summary()).toBe('More: none · Less: AI & tech');
    let interests = await stored();
    expect(Object.keys(interests.more)).toEqual([]);
    expect(Object.keys(interests.less)).toEqual(['ai-tech']);

    await user.click(more('AI & tech'));
    await waitFor(() => expect(pressed(more('AI & tech'))).toBe('true'));
    expect(pressed(less('AI & tech'))).toBe('false');
    interests = await stored();
    expect(Object.keys(interests.more)).toEqual(['ai-tech']);
    expect(Object.keys(interests.less)).toEqual([]);
  });

  it('test_pressing_the_pressed_button_clears_the_topic', async () => {
    const user = await renderList();
    await user.click(less('Celebrity news'));
    await waitFor(() => expect(pressed(less('Celebrity news'))).toBe('true'));
    await user.click(less('Celebrity news'));
    await waitFor(() => expect(pressed(less('Celebrity news'))).toBe('false'));
    expect(pressed(more('Celebrity news'))).toBe('false');
    expect(await stored()).toMatchObject({ more: {}, less: {} });
    expect(summary()).toBe('More: none · Less: none');
  });

  it('test_marks_already_stored_show_as_pressed', async () => {
    // Settings from the two lists: a starter topic of "More of", one of "Less of", and an old onboarding own topic.
    await seed({
      more: { 'ai-tech': topic('AI & tech'), 'custom-1700000000000': topic('Gardening') },
      less: { politics: topic('Politics') },
    });
    await renderList();
    expect(pressed(more('AI & tech'))).toBe('true');
    expect(pressed(less('Politics'))).toBe('true');
    expect(pressed(more('Gardening'))).toBe('true');
    expect(rows().at(-1)).toBe('Gardening');
    expect(summary()).toBe('More: AI & tech, Gardening · Less: Politics');
  });

  it('test_politics_typed_under_the_old_more_of_is_one_row', async () => {
    // Settings from the old lists, where Politics was only under "Less of", so it was typed as an own topic.
    const typed = '0190a0b0-0000-7000-8000-000000000001';
    await seed({ more: { [typed]: topic('Politics', ['Politics'], AT) }, less: { celebrity: topic('Celebrity news') } });
    const user = await renderList();
    expect(screen.getAllByRole('group', { name: 'Politics' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'More: Politics' })).toHaveLength(1);
    expect(pressed(more('Politics'))).toBe('true');
    expect(pressed(less('Politics'))).toBe('false');
    expect(within(screen.getByRole('group', { name: 'Politics' })).queryByText(TOPIC_COPY.own)).toBeNull();
    expect(summary()).toBe('More: Politics · Less: Celebrity news');
    expect(rows()).toEqual(STARTERS.map((t) => t.label));
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(new Set(names).size).toBe(names.length);
    // Shown is not stored: it keeps its own id, and sync its keys, until the row is marked again.
    expect(Object.keys((await stored()).more)).toEqual([typed]);

    await user.click(less('Politics'));
    await waitFor(() => expect(pressed(less('Politics'))).toBe('true'));
    expect(pressed(more('Politics'))).toBe('false');
    let interests = await stored();
    expect(interests.more).toEqual({});
    expect(Object.keys(interests.less).sort()).toEqual(['celebrity', 'politics']);
    expect(interests.less.politics?.keywords).toEqual(POLITICS?.keywords);

    await user.click(less('Politics'));
    await waitFor(() => expect(pressed(less('Politics'))).toBe('false'));
    interests = await stored();
    expect(Object.keys(interests.less)).toEqual(['celebrity']);
    expect(screen.getAllByRole('group', { name: 'Politics' })).toHaveLength(1);
  });

  it('test_a_mark_syncs_under_the_same_keys', async () => {
    const user = await renderList();
    const keys = async () => new Set(Object.keys(await settingsClocksItem.getValue()).map(settingsItemKey));
    await user.click(more('Politics'));
    await waitFor(async () => expect(await keys()).toContain('interests.more.politics'));
    const before = await settingsClocksItem.getValue();
    await user.click(less('Politics'));
    await waitFor(async () => expect(await keys()).toContain('interests.less.politics'));
    // Leaving More is an edit of `interests.more.politics` too, so the other device drops it.
    const after = await settingsClocksItem.getValue();
    expect(after['interests.more.politics']).not.toBe(before['interests.more.politics']);
  });

  it('test_keyboard_marks_a_topic', async () => {
    const user = await renderList();
    more('Startups').focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(pressed(more('Startups'))).toBe('true'));
    await user.tab();
    expect(document.activeElement).toBe(less('Startups'));
    await user.keyboard(' ');
    await waitFor(() => expect(pressed(less('Startups'))).toBe('true'));
    expect(pressed(more('Startups'))).toBe('false');
  });
});

describe('topics: your own', () => {
  it('test_an_own_topic_is_added_as_more_and_listed', async () => {
    const user = await renderList();
    const field = screen.getByRole('textbox', { name: TOPIC_COPY.add });
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add.hasAttribute('disabled')).toBe(true);
    await user.type(field, '   ');
    expect(add.hasAttribute('disabled')).toBe(true);
    await user.clear(field);
    await user.type(field, '  Supply   chain {Enter}');
    const row = await screen.findByRole('group', { name: 'Supply chain' });
    expect(within(row).getByText(TOPIC_COPY.own)).toBeTruthy();
    expect(pressed(more('Supply chain'))).toBe('true');
    expect(rows().at(-1)).toBe('Supply chain');
    expect((field as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('status').textContent).toBe('Added Supply chain as More.');
    expect(summary()).toBe('More: Supply chain · Less: none');
    const entries = Object.entries((await stored()).more);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toMatch(UUID);
    expect(entries[0]?.[1]).toMatchObject({ label: 'Supply chain', keywords: ['Supply chain'] });
    // The settings take names up to 40 characters.
    expect(field.getAttribute('maxlength')).toBe('40');
  });

  it('test_an_own_topic_moves_to_less_and_keeps_its_place', async () => {
    await seed({ more: { mine: topic('Gardening', ['gardening', 'garden'], AT) } });
    const user = await renderList();
    await user.click(less('Gardening'));
    await waitFor(() => expect(pressed(less('Gardening'))).toBe('true'));
    const interests = await stored();
    expect(interests.more).toEqual({});
    expect(interests.less).toEqual({ mine: topic('Gardening', ['gardening', 'garden'], AT) });
    expect(rows().at(-1)).toBe('Gardening');
  });

  it('test_clearing_an_own_topic_removes_it', async () => {
    await seed({ more: { mine: topic('Gardening') }, less: { theirs: topic('Golf', ['golf'], AT + 1) } });
    const user = await renderList();
    await user.click(more('Gardening'));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Gardening' })).toBeNull());
    // Its row is gone, so focus goes to where topics are added.
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: TOPIC_COPY.add }));
    await user.click(less('Golf'));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Golf' })).toBeNull());
    expect(await stored()).toMatchObject({ more: {}, less: {} });
    expect(rows()).toEqual(STARTERS.map((t) => t.label));
  });

  it('test_adding_a_listed_name_marks_that_topic', async () => {
    await seed({ less: { politics: topic('Politics') } });
    const user = await renderList();
    await user.type(screen.getByRole('textbox', { name: TOPIC_COPY.add }), 'politics{Enter}');
    await waitFor(() => expect(pressed(more('Politics'))).toBe('true'));
    expect(pressed(less('Politics'))).toBe('false');
    expect(screen.getByRole('status').textContent).toBe('Politics is marked More.');
    const interests = await stored();
    expect(Object.keys(interests.more)).toEqual(['politics']);
    expect(interests.less).toEqual({});
    expect(rows()).toEqual(STARTERS.map((t) => t.label));
  });
});

describe('topics: a shorter list', () => {
  it('test_limit_shows_the_first_topics_and_the_marked_ones', async () => {
    await seed({ less: { politics: topic('Politics') }, more: { mine: topic('Gardening') } });
    const user = await renderList({ limit: 10 });
    expect(rows()).toEqual([...STARTERS.slice(0, 10).map((t) => t.label), 'Politics', 'Gardening']);
    const showAll = screen.getByRole('button', { name: TOPIC_COPY.showAll });
    expect(showAll.getAttribute('aria-expanded')).toBe('false');
    await user.click(showAll);
    expect(rows()).toEqual([...STARTERS.map((t) => t.label), 'Gardening']);
    // The topics it showed come before it, so focus moves to the first of them.
    expect(document.activeElement).toBe(more(STARTERS[10]?.label ?? ''));
    const fewer = screen.getByRole('button', { name: TOPIC_COPY.showFewer });
    expect(fewer.getAttribute('aria-expanded')).toBe('true');
    await user.click(fewer);
    expect(rows()).toHaveLength(12);
  });

  it('test_clearing_a_topic_keeps_its_row_in_the_shorter_list', async () => {
    // Shown past the first ten because it's marked (Show all, mark it, Continue, Back): clearing it keeps it in place.
    await seed({ more: { politics: topic('Politics') } });
    const user = await renderList({ limit: 10 });
    expect(rows()).toEqual([...STARTERS.slice(0, 10).map((t) => t.label), 'Politics']);
    more('Politics').focus();
    await user.keyboard('{Enter}');
    await waitFor(async () => expect((await stored()).more).toEqual({}));
    expect(pressed(more('Politics'))).toBe('false');
    expect(document.activeElement).toBe(more('Politics'));
    expect(rows()).toEqual([...STARTERS.slice(0, 10).map((t) => t.label), 'Politics']);
    expect(summary()).toBe('More: none · Less: none');
    // Still there to mark again.
    await user.tab();
    await user.keyboard(' ');
    await waitFor(() => expect(pressed(less('Politics'))).toBe('true'));
    // Show all, then Show fewer: the shorter list is the first ten and the marked ones.
    await user.click(less('Politics'));
    await waitFor(() => expect(pressed(less('Politics'))).toBe('false'));
    await user.click(screen.getByRole('button', { name: TOPIC_COPY.showAll }));
    expect(document.activeElement).toBe(more(STARTERS[10]?.label ?? ''));
    expect(rows()).toEqual(STARTERS.map((t) => t.label));
  });
});

describe('topics in Settings and onboarding', () => {
  it('test_interests_pane_has_one_topic_list', async () => {
    const user = setupUser();
    function Pane() {
      const [settings, save] = useSettings();
      return settings ? <InterestsPane settings={settings} save={save} /> : null;
    }
    render(<Pane />);
    await screen.findByRole('heading', { level: 1, name: 'Interests' });
    const groups = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(groups).toEqual(['Topics', 'About you', 'Keywords', 'What unAlgorithm learned']);
    expect(screen.getByText(TOPIC_COPY.intro)).toBeTruthy();
    expect(screen.queryByText(/More of|Less of/)).toBeNull();
    expect(rows()).toEqual(STARTERS.map((t) => t.label));
    await user.click(more('Politics'));
    await waitFor(async () => expect(Object.keys((await stored()).more)).toEqual(['politics']));
  });

  it('test_onboarding_interests_step', async () => {
    vi.spyOn(fakeBrowser.permissions, 'getAll').mockResolvedValue({ origins: [], permissions: [] } as never);
    const user = setupUser();
    render(<Onboarding />);
    await user.click(await screen.findByRole('button', { name: 'Get started' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'What do you want more or less of?' })).toBeTruthy();
    expect(screen.getByText(TOPIC_COPY.intro)).toBeTruthy();
    expect(screen.queryByRole('button', { name: "Anything you'd like less of?" })).toBeNull();
    expect(rows()).toHaveLength(10);
    expect(screen.getByText('0 selected')).toBeTruthy();

    await user.click(more('AI & tech'));
    await screen.findByText('1 selected');
    await user.click(screen.getByRole('button', { name: TOPIC_COPY.showAll }));
    await user.click(more('Politics'));
    await screen.findByText('2 selected');
    await user.click(less('Crypto & get-rich-quick'));
    // Marked More or Less: both count.
    await screen.findByText('3 selected');
    expect(summary()).toBe('More: AI & tech, Politics · Less: Crypto & get-rich-quick');

    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(await screen.findByRole('heading', { level: 1, name: /Want smarter filtering/ })).toBeTruthy();
    const interests = await stored();
    expect(Object.keys(interests.more).sort()).toEqual(['ai-tech', 'politics']);
    expect(Object.keys(interests.less)).toEqual(['crypto']);
  });
});
