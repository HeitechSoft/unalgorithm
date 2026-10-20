import {
  applyPreset,
  defaultSettings,
  deleteAtKey,
  editPaths,
  migrateSettings,
  presetOf,
  type Settings,
  type SettingsClocks,
  SettingsSchema,
  setAtKey,
  stampClocks,
  type Topic,
  upgradeClocks,
} from '@unalgorithm/core';
import { compareHlc, formatHlc, HLC_ZERO, type SyncItem } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { applyRemoteItems, changedItems, dropAfterResync, normalizeClocks, SETTINGS_COLLECTION } from '../src/index.ts';

const DEVICE_A = '0190f5c8-3b1e-7c2a-9d4e-123456789abc';
const DEVICE_B = '0190f5c8-3b1e-7c2a-9d4e-cba987654321';
const T0 = 1_760_000_000_000;
const DAY = 86_400_000;

/** A stamp `n` milliseconds after T0: a higher `n` is a later edit. */
function hlc(n: number, device = DEVICE_A): string {
  return formatHlc({ ms: T0 + n, counter: 0, device });
}

/** A stamp at the start of day `n` after T0. */
function day(n: number): string {
  return hlc(n * DAY);
}

function topic(label: string, keywords: string[] = []): Topic {
  return { label, keywords, addedAt: 1 };
}

function live(key: string, value: unknown, at: string, collection = SETTINGS_COLLECTION): SyncItem {
  return { collection, key, hlc: at, deleted: false, value } as SyncItem;
}

function tombstone(key: string, at: string): SyncItem {
  return { collection: SETTINGS_COLLECTION, key, hlc: at, deleted: true };
}

/** Narrows an apply result to its success branch, failing the test otherwise. */
function applied(result: ReturnType<typeof applyRemoteItems>) {
  if (!result.ok) throw new Error(`apply failed: ${result.reason}`);
  return result;
}

/** What the server holds after it took `items`: item key → HLC. */
function knownFrom(items: readonly SyncItem[]): Record<string, string> {
  return Object.fromEntries(items.map((item) => [item.key, item.hlc]));
}

const GSK_KEY = `display.gsk_${'A'.repeat(52)}`;
const ANT_KEY = `sk-ant-api03-${'A'.repeat(20)}`;

describe('clocks', () => {
  it('test_normalize_clocks_to_item_keys', () => {
    const s = defaultSettings();
    s.interests.more.X = topic('X', ['x']);
    expect(
      normalizeClocks(s, {
        'interests.more.X.label': hlc(5),
        'interests.more.X.keywords': hlc(7),
        'display.mode': hlc(3),
        version: hlc(9),
      }),
    ).toEqual({ 'interests.more.X': hlc(7), 'display.mode': hlc(3) });

    // An ancestor stamp covers every item below it: each entry key plus the plain setting beside the maps.
    s.interests.more.Y = topic('Y');
    s.interests.less.Z = topic('Z');
    s.interests.muteWords.W = { label: 'W', addedAt: 1 };
    const ancestor = normalizeClocks(s, { interests: hlc(8) });
    expect(ancestor).toEqual({
      'interests.more.X': hlc(8),
      'interests.more.Y': hlc(8),
      'interests.less.Z': hlc(8),
      'interests.muteWords.W': hlc(8),
      'interests.about': hlc(8),
    });
    // The newer of an ancestor stamp and an item's own stamp wins, in either order.
    expect(normalizeClocks(s, { 'interests.more.X.label': hlc(9), interests: hlc(8) })['interests.more.X']).toBe(hlc(9));
    expect(normalizeClocks(s, { interests: hlc(8), 'interests.more.X.label': hlc(4) })['interests.more.X']).toBe(hlc(8));
    // An object of plain settings expands to its leaves.
    expect(Object.keys(normalizeClocks(s, { display: hlc(2) }))).toHaveLength(7);

    // Paths that never sync, reserved segments and stamps that are not HLCs are dropped.
    expect(
      normalizeClocks(s, {
        'display.mode.x': hlc(1),
        '__proto__.x': hlc(1),
        'constructor.prototype.x': hlc(1),
        'interests.more.X.label/x': hlc(1),
        'display.tips': 'not a stamp',
      }),
    ).toEqual({});
    // A deleted entry keeps its stamp: it becomes a tombstone.
    expect(normalizeClocks(defaultSettings(), { 'interests.more.gone': hlc(4) })).toEqual({ 'interests.more.gone': hlc(4) });
  });
});

describe('changed items', () => {
  it('test_untouched_defaults_send_nothing', () => {
    expect(changedItems(defaultSettings(), {}, {})).toEqual({ items: [], withheld: [] });
  });

  it('test_changed_items_against_known', () => {
    const s = defaultSettings();
    s.display.mode = 'hide';
    s.interests.more.X = topic('X', ['x']);
    const clocks: SettingsClocks = { 'display.mode': hlc(1), 'interests.more.X': hlc(2) };

    expect(changedItems(s, clocks, {})).toEqual({
      items: [live('display.mode', 'hide', hlc(1)), live('interests.more.X', topic('X', ['x']), hlc(2))],
      withheld: [],
    });
    expect(changedItems(s, clocks, { 'display.mode': hlc(1) }).items).toEqual([
      live('interests.more.X', topic('X', ['x']), hlc(2)),
    ]);
    // The server already holding a newer stamp is not a change either.
    expect(changedItems(s, clocks, { 'display.mode': hlc(5), 'interests.more.X': hlc(2) }).items).toEqual([]);

    delete s.interests.more.X;
    const deleted = { ...clocks, 'interests.more.X': hlc(3) };
    expect(changedItems(s, deleted, { 'display.mode': hlc(1), 'interests.more.X': hlc(2) }).items).toEqual([
      tombstone('interests.more.X', hlc(3)),
    ]);
  });

  it('test_changed_items_leaves_out_invalid_items', () => {
    // Settings the schema accepts but Postgres jsonb cannot store: U+0000 and a lone surrogate.
    const s = defaultSettings();
    s.interests.about = 'a\u0000b';
    s.interests.more.X = topic('x\uD83D');
    s.display.mode = 'hide';
    expect(SettingsSchema.safeParse(s).success).toBe(true);
    const clocks: SettingsClocks = { 'interests.about': hlc(1), 'interests.more.X': hlc(2), 'display.mode': hlc(3) };

    expect(changedItems(s, clocks, {})).toEqual({ items: [live('display.mode', 'hide', hlc(3))], withheld: [] });
  });

  it('test_changed_items_withholds_credentials', () => {
    const s = defaultSettings();
    s.interests.about = `my key is ${ANT_KEY}`;
    s.interests.more.X = topic('X', [ANT_KEY]);
    s.display.mode = 'dim';
    (s.display as Record<string, unknown>)[GSK_KEY.slice('display.'.length)] = true;
    const clocks: SettingsClocks = {
      'interests.about': hlc(1),
      'interests.more.X': hlc(2),
      'display.mode': hlc(3),
      [GSK_KEY]: hlc(4),
    };

    const out = changedItems(s, clocks, {});
    expect(out.withheld.sort()).toEqual(['interests.about', 'interests.more.X', GSK_KEY].sort());
    expect(out.items).toEqual([live('display.mode', 'dim', hlc(3))]);
    expect(JSON.stringify(out.items)).not.toMatch(/sk-ant|gsk_/);

    // The same key as a tombstone: the key alone holds the provider key.
    const gone = defaultSettings();
    const tombstoned = changedItems(gone, { [GSK_KEY]: hlc(5) }, {});
    expect(tombstoned).toEqual({ items: [], withheld: [GSK_KEY] });
  });
});

describe('applying remote items', () => {
  it('test_concurrent_edits_to_different_fields_both_survive', () => {
    const start = defaultSettings();
    const a = structuredClone(start);
    a.display.mode = 'hide';
    const aClocks: SettingsClocks = { 'display.mode': hlc(10, DEVICE_A) };
    const b = structuredClone(start);
    b.interests.more.Y = topic('Y', ['y']);
    const bClocks: SettingsClocks = { 'interests.more.Y.label': hlc(5, DEVICE_B), 'interests.more.Y.keywords': hlc(6, DEVICE_B) };
    const aBefore = structuredClone({ a, aClocks });

    const fromA = changedItems(a, aClocks, {}).items;
    const fromB = changedItems(b, bClocks, {}).items;
    const onA = applied(applyRemoteItems(a, aClocks, fromB));
    const onB = applied(applyRemoteItems(b, bClocks, fromA));

    for (const merged of [onA, onB]) {
      expect(merged.settings.display.mode).toBe('hide');
      expect(merged.settings.interests.more.Y).toEqual(topic('Y', ['y']));
    }
    // Both devices converge on the same settings and the same clocks.
    expect(onA.settings).toEqual(onB.settings);
    expect(onA.clocks).toEqual(onB.clocks);
    expect(onA.clocks).toEqual({ 'display.mode': hlc(10, DEVICE_A), 'interests.more.Y': hlc(6, DEVICE_B) });
    // Pure: the inputs are left as they were.
    expect({ a, aClocks }).toEqual(aBefore);
  });

  it('test_same_field_newest_wins', () => {
    const s = defaultSettings();
    s.display.mode = 'dim';
    const clocks: SettingsClocks = { 'display.mode': hlc(5) };

    const newer = applied(applyRemoteItems(s, clocks, [live('display.mode', 'hide', hlc(6, DEVICE_B))]));
    expect(newer.settings.display.mode).toBe('hide');
    expect(newer.clocks['display.mode']).toBe(hlc(6, DEVICE_B));
    expect(newer.skipped).toEqual([]);

    for (const at of [hlc(4, DEVICE_B), hlc(5)]) {
      const older = applied(applyRemoteItems(s, clocks, [live('display.mode', 'hide', at)]));
      expect(older.settings.display.mode).toBe('dim');
      expect(older.clocks['display.mode']).toBe(hlc(5));
      expect(older.applied).toEqual([]);
      expect(older.skipped).toEqual([{ key: 'display.mode', reason: 'older' }]);
    }

    // The same key twice in one batch: the later item compares with the earlier one's result.
    const twice = applied(
      applyRemoteItems(s, clocks, [
        live('display.mode', 'hide', hlc(8, DEVICE_B)),
        live('display.mode', 'collapse', hlc(7, DEVICE_B)),
      ]),
    );
    expect(twice.settings.display.mode).toBe('hide');
    expect(twice.skipped).toEqual([{ key: 'display.mode', reason: 'older' }]);
    const inOrder = applied(
      applyRemoteItems(s, clocks, [
        live('display.mode', 'hide', hlc(7, DEVICE_B)),
        live('display.mode', 'collapse', hlc(8, DEVICE_B)),
      ]),
    );
    expect(inOrder.settings.display.mode).toBe('collapse');
    expect(inOrder.clocks['display.mode']).toBe(hlc(8, DEVICE_B));
  });

  it('test_tombstone_vs_edit_by_hlc', () => {
    const s = defaultSettings();
    s.interests.more.X = topic('X');
    const clocks: SettingsClocks = { 'interests.more.X.label': hlc(5) };

    const removed = applied(applyRemoteItems(s, clocks, [tombstone('interests.more.X', hlc(6, DEVICE_B))]));
    expect(Object.hasOwn(removed.settings.interests.more, 'X')).toBe(false);
    expect(removed.clocks['interests.more.X']).toBe(hlc(6, DEVICE_B));

    const kept = applied(applyRemoteItems(s, clocks, [tombstone('interests.more.X', hlc(4, DEVICE_B))]));
    expect(kept.settings.interests.more.X).toEqual(topic('X'));
    expect(kept.skipped).toEqual([{ key: 'interests.more.X', reason: 'older' }]);

    // An edit newer than a local delete brings the entry back.
    const back = applied(applyRemoteItems(removed.settings, removed.clocks, [live('interests.more.X', topic('X2'), hlc(7))]));
    expect(back.settings.interests.more.X).toEqual(topic('X2'));
  });

  it('test_invalid_and_foreign_items_skipped', () => {
    const s = defaultSettings();
    const result = applied(
      applyRemoteItems(s, {}, [
        live('display.mode', 'shout', hlc(1, DEVICE_B)),
        live('display.tips', false, hlc(2, DEVICE_B)),
        live('topics.ai', { weight: 1 }, hlc(3, DEVICE_B), 'learned'),
        live('__proto__.x', 1, hlc(4, DEVICE_B)),
        live('constructor.prototype.x', 1, hlc(5, DEVICE_B)),
        live('interests.more.Y', topic(''), hlc(6, DEVICE_B)),
      ]),
    );
    expect(result.skipped).toEqual([
      { key: 'display.mode', reason: 'invalid' },
      { key: 'topics.ai', reason: 'other-collection' },
      { key: '__proto__.x', reason: 'invalid' },
      { key: 'constructor.prototype.x', reason: 'invalid' },
      { key: 'interests.more.Y', reason: 'invalid' },
    ]);
    // Nothing else in the batch is affected.
    expect(result.applied.map((item) => item.key)).toEqual(['display.tips']);
    expect(result.settings).toEqual({ ...defaultSettings(), display: { ...defaultSettings().display, tips: false } });
    expect(result.clocks).toEqual({ 'display.tips': hlc(2, DEVICE_B) });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, 'x')).toBe(false);
  });

  it('test_apply_refuses_a_result_that_fails_the_schema', () => {
    // Every item passes its own schema, so only settings that were already broken can fail as a whole.
    const broken = { ...defaultSettings(), version: 0 } as unknown as Settings;
    expect(applyRemoteItems(broken, {}, [live('display.tips', false, hlc(1))])).toEqual({ ok: false, reason: 'schema' });
  });

  it('test_apply_reports_max_hlc_and_suppresses_echo', () => {
    const s = defaultSettings();
    s.display.groupRuns = false;
    const clocks: SettingsClocks = { 'display.groupRuns': hlc(1) };
    const batch = [
      live('display.mode', 'hide', hlc(3, DEVICE_B)),
      live('interests.more.Y', topic('Y'), hlc(7, DEVICE_B)),
      tombstone('interests.less.gone', hlc(5, DEVICE_B)),
      // Skipped items never count toward maxHlc.
      live('display.mode', 'shout', hlc(99, DEVICE_B)),
      live('display.tips', false, hlc(98, DEVICE_B), 'learned'),
    ];

    const result = applied(applyRemoteItems(s, clocks, batch));
    expect(result.maxHlc).toBe(hlc(7, DEVICE_B));
    expect(result.applied).toEqual(batch.slice(0, 3));
    for (const item of result.applied) expect(result.clocks[item.key]).toBe(item.hlc);
    // Applied items are not changes: only the local edit is still to send.
    expect(changedItems(result.settings, result.clocks, knownFrom(result.applied)).items).toEqual([
      live('display.groupRuns', false, hlc(1)),
    ]);

    const none = applied(applyRemoteItems(s, clocks, [live('display.groupRuns', true, hlc(0))]));
    expect(none.maxHlc).toBeNull();
    expect(applied(applyRemoteItems(s, clocks, [])).maxHlc).toBeNull();
  });

  it('test_prefer_remote_on_first_pull', () => {
    const s = defaultSettings();
    s.display.mode = 'dim';
    s.interests.more.X = topic('X');
    s.interests.more.L = topic('Local only');
    const clocks: SettingsClocks = {
      'display.mode': hlc(10),
      'interests.more.X': hlc(10),
      'interests.more.L': hlc(10),
    };
    const batch = [live('display.mode', 'hide', hlc(5, DEVICE_B)), tombstone('interests.more.X', hlc(5, DEVICE_B))];

    const first = applied(applyRemoteItems(s, clocks, batch, { preferRemote: true }));
    expect(first.settings.display.mode).toBe('hide');
    expect(Object.hasOwn(first.settings.interests.more, 'X')).toBe(false);
    expect(first.clocks['display.mode']).toBe(hlc(5, DEVICE_B));
    expect(first.clocks['interests.more.X']).toBe(hlc(5, DEVICE_B));
    expect(first.skipped).toEqual([]);
    expect(first.maxHlc).toBe(hlc(5, DEVICE_B));
    expect(changedItems(first.settings, first.clocks, knownFrom(batch)).items).toEqual([
      live('interests.more.L', topic('Local only'), hlc(10)),
    ]);

    // Among the server's own items the newest still wins.
    const twice = applied(
      applyRemoteItems(
        s,
        clocks,
        [live('display.mode', 'hide', hlc(6, DEVICE_B)), live('display.mode', 'collapse', hlc(4, DEVICE_B))],
        {
          preferRemote: true,
        },
      ),
    );
    expect(twice.settings.display.mode).toBe('hide');
    expect(twice.skipped).toEqual([{ key: 'display.mode', reason: 'older' }]);

    const plain = applied(applyRemoteItems(s, clocks, batch));
    expect(plain.settings.display.mode).toBe('dim');
    expect(plain.settings.interests.more.X).toEqual(topic('X'));
    expect(plain.skipped).toEqual([
      { key: 'display.mode', reason: 'older' },
      { key: 'interests.more.X', reason: 'older' },
    ]);
    expect(plain.maxHlc).toBeNull();
  });
});

describe("settings version 2: Facebook's Balanced hides people you don't follow", () => {
  const FB = 'platforms.facebook';
  const NF = `${FB}.filters.notFollowed`;
  const notFollowed = (s: Settings) => s.platforms.facebook.filters.notFollowed;

  /**
   * What a computer still on version 1 sends when its person picks Balanced on Facebook after Calm: every field that
   * changed, people you don't follow back off (version 1's Balanced).
   */
  function balancedFromVersion1(at: string): SyncItem[] {
    return [
      live(`${FB}.preset`, 'balanced', at),
      live(NF, false, at),
      live(`${FB}.filters.reels`, false, at),
      live(`${FB}.filters.reshares`, false, at),
      live(`${FB}.ai.noise.promotional`, false, at),
      live(`${FB}.ai.noise.low-effort`, false, at),
      live(`${FB}.ai.lowRelevance`, false, at),
    ];
  }

  /** What a computer still on version 1 sends when its person picks Light after its default Balanced. */
  function lightFromVersion1(at: string): SyncItem[] {
    return [
      live(`${FB}.preset`, 'light', at),
      live(`${FB}.filters.suggested`, false, at),
      live(`${FB}.filters.networkActivity`, false, at),
      live(`${FB}.filters.unjoinedGroups`, false, at),
      live(`${FB}.ai.noise.engagement-bait`, false, at),
      live(`${FB}.ai.noise.rage-bait`, false, at),
      live(`${FB}.ai.noise.clickbait`, false, at),
    ];
  }

  /** A computer's settings and clocks. One still on version 1 keeps them raw, as that version stored them. */
  interface Computer {
    raw: Record<string, unknown>;
    clocks: SettingsClocks;
  }

  /** Version 1's settings with Facebook on version 1's Balanced, and the clocks of `items` it sent or took. */
  function onVersion1(items: readonly SyncItem[] = []): Computer {
    const s = defaultSettings();
    s.platforms.facebook.filters.notFollowed = false;
    const raw: Record<string, unknown> = { ...structuredClone(s), version: 1 };
    const computer = { raw, clocks: {} };
    applyAsVersion1(computer, items);
    return computer;
  }

  /** Version 1's merge: each newer item replaces its value, and nothing reads a strength again. */
  function applyAsVersion1(c: Computer, items: readonly SyncItem[]): void {
    for (const item of items) {
      if (compareHlc(item.hlc, c.clocks[item.key] ?? HLC_ZERO) <= 0) continue;
      if (item.deleted) deleteAtKey(c.raw, item.key);
      else setAtKey(c.raw, item.key, item.value);
      c.clocks[item.key] = item.hlc;
    }
  }

  /** The computer updates to version 2 (the first write after it, as `upgradeStoredSettings` does). */
  function update(c: Computer, device: string): { settings: Settings; clocks: SettingsClocks } {
    return { settings: migrateSettings(c.raw), clocks: upgradeClocks(c.raw, c.clocks, device, undefined).clocks };
  }

  /** An edit on version 2 at `n` ms after T0, as `updateSettings` stamps it. */
  function edit(s: Settings, clocks: SettingsClocks, device: string, n: number, mutate: (s: Settings) => void) {
    const after = structuredClone(s);
    mutate(after);
    after.platforms.facebook.preset = presetOf('facebook', after.platforms.facebook);
    return { settings: after, clocks: stampClocks(clocks, editPaths(s, after), device, undefined, T0 + n).clocks };
  }

  /** The server: item key → the newest item it took. */
  class Server {
    readonly items = new Map<string, SyncItem>();
    push(items: readonly SyncItem[]): void {
      for (const item of items) {
        const held = this.items.get(item.key);
        if (!held || compareHlc(item.hlc, held.hlc) > 0) this.items.set(item.key, item);
      }
    }
    get known(): Record<string, string> {
      return knownFrom([...this.items.values()]);
    }
    get all(): SyncItem[] {
      return [...this.items.values()];
    }
  }

  it('test_old_balanced_from_a_version_1_device_reads_as_todays', () => {
    const batch = balancedFromVersion1(hlc(5, DEVICE_B));
    for (const preferRemote of [false, true]) {
      const result = applied(applyRemoteItems(defaultSettings(), {}, batch, { preferRemote }));
      expect(notFollowed(result.settings)).toBe(true);
      expect(presetOf('facebook', result.settings.platforms.facebook)).toBe('balanced');
      // The items' own clocks, and nothing to send back: reading a strength is not an edit.
      expect(result.clocks[NF]).toBe(hlc(5, DEVICE_B));
      expect(changedItems(result.settings, result.clocks, knownFrom(batch)).items).toEqual([]);
    }
  });

  it('test_a_custom_choice_from_another_device_is_kept', () => {
    // On version 2, Balanced without the rule is Custom: that device sends both.
    const off = [live(NF, false, hlc(6, DEVICE_B)), live(`${FB}.preset`, 'custom', hlc(6, DEVICE_B))];
    const result = applied(applyRemoteItems(defaultSettings(), {}, off));
    expect(notFollowed(result.settings)).toBe(false);
    expect(presetOf('facebook', result.settings.platforms.facebook)).toBe('custom');
    // Version 1's Custom (its Balanced, and Reels hidden too) stays Custom as well.
    const custom: Record<string, unknown> = { [`${FB}.preset`]: 'custom', [`${FB}.filters.reels`]: true };
    const v1Custom = balancedFromVersion1(hlc(7, DEVICE_B)).map((item) =>
      Object.hasOwn(custom, item.key) ? live(item.key, custom[item.key], item.hlc) : item,
    );
    const kept = applied(applyRemoteItems(defaultSettings(), {}, v1Custom));
    expect(kept.settings.platforms.facebook.filters).toMatchObject({ notFollowed: false, reels: true });
    expect(presetOf('facebook', kept.settings.platforms.facebook)).toBe('custom');
  });

  it('test_items_split_across_pages_read_as_one_batch', () => {
    // A computer on version 2 turns the rule off: the filter and Custom may arrive in separate pages, either way round.
    const off = [live(NF, false, hlc(10, DEVICE_B)), live(`${FB}.preset`, 'custom', hlc(10, DEVICE_B))];
    // Version 1's Balanced, picked after Calm, split the same ways.
    const old = balancedFromVersion1(hlc(9, DEVICE_B));
    const calm = defaultSettings();
    calm.platforms.facebook = applyPreset('facebook', calm.platforms.facebook, 'calm');
    const calmClocks = { [`${FB}.preset`]: hlc(1), [NF]: hlc(1) };
    for (const [start, startClocks, items, value, preset] of [
      [defaultSettings(), { [`${FB}.preset`]: hlc(1) }, off, false, 'custom'],
      [calm, calmClocks, old, true, 'balanced'],
    ] as const) {
      for (const pages of [[items.slice(0, 1), items.slice(1)], [items.slice(1), items.slice(0, 1)], [[...items]]]) {
        let s: Settings = start;
        let clocks: SettingsClocks = startClocks;
        for (const page of pages) ({ settings: s, clocks } = applied(applyRemoteItems(s, clocks, page)));
        expect([notFollowed(s), presetOf('facebook', s.platforms.facebook)]).toEqual([value, preset]);
      }
    }
  });

  it('test_a_customisation_after_the_update_reaches_a_version_1_device', () => {
    for (const storedOnA of [true, false]) {
      // Both computers on version 1's untouched Balanced. A updates (with settings stored, or none: its defaults).
      const server = new Server();
      const c = onVersion1();
      let a = storedOnA ? update(onVersion1(), DEVICE_A) : { settings: defaultSettings(), clocks: {} };
      server.push(changedItems(a.settings, a.clocks, server.known).items);
      applyAsVersion1(c, server.all);
      // On A the person also hides promotional posts: Facebook is Custom, people you don't follow still hidden.
      a = edit(a.settings, a.clocks, DEVICE_A, 100, (s) => void (s.platforms.facebook.ai.noise.promotional = true));
      server.push(changedItems(a.settings, a.clocks, server.known).items);
      applyAsVersion1(c, server.all);
      // C, still on version 1, and C after it updates: the same filter as A.
      expect((c.raw.platforms as Settings['platforms']).facebook.filters.notFollowed).toBe(true);
      const updated = update(c, DEVICE_B);
      expect(updated.settings.platforms.facebook).toEqual(a.settings.platforms.facebook);
      expect(changedItems(updated.settings, updated.clocks, server.known).items).toEqual([]);
    }
  });

  it('test_a_computer_that_starts_syncing_later_reads_what_the_updated_one_shows', () => {
    // The server holds version 1's Balanced, picked after Calm; A took it and then updated, and hid Reels too.
    const server = new Server();
    const old = balancedFromVersion1(hlc(1));
    server.push(old);
    let a = update(onVersion1(old), DEVICE_A);
    expect(notFollowed(a.settings)).toBe(true);
    // The upgrade goes to the server once, behind anything stamped later.
    const sent = changedItems(a.settings, a.clocks, server.known).items;
    expect(sent.map((item) => [item.key, item.deleted ? null : item.value])).toEqual([[NF, true]]);
    expect(compareHlc(sent[0]?.hlc ?? '', hlc(2))).toBeLessThan(0);
    server.push(sent);
    a = edit(a.settings, a.clocks, DEVICE_A, 50, (s) => void (s.platforms.facebook.filters.reels = true));
    server.push(changedItems(a.settings, a.clocks, server.known).items);
    // B is installed later and pulls everything: Custom, with people you don't follow hidden, as on A.
    const b = applied(applyRemoteItems(defaultSettings(), {}, server.all, { preferRemote: true }));
    expect(b.settings.platforms.facebook).toEqual(a.settings.platforms.facebook);
    expect(changedItems(b.settings, b.clocks, server.known).items).toEqual([]);
  });

  it('test_a_strength_picked_on_version_1_reads_the_same_on_a_computer_installed_later', () => {
    // Light from the default Balanced: version 1 never sends the filter (it was off in both).
    const server = new Server();
    server.push(lightFromVersion1(hlc(3, DEVICE_B)));
    const b = applied(applyRemoteItems(defaultSettings(), {}, server.all, { preferRemote: true }));
    expect(notFollowed(b.settings)).toBe(false);
    expect(presetOf('facebook', b.settings.platforms.facebook)).toBe('light');
  });

  it('test_a_customisation_on_a_version_1_device_ends_the_same_everywhere', () => {
    for (const storedOnA of [true, false]) {
      // A is on version 2 (updated with settings stored, or installed fresh); C, still on version 1, hides Reels.
      const server = new Server();
      let a = storedOnA ? update(onVersion1(), DEVICE_A) : { settings: defaultSettings(), clocks: {} };
      const c = onVersion1();
      const reels = [live(`${FB}.preset`, 'custom', hlc(20, DEVICE_B)), live(`${FB}.filters.reels`, true, hlc(20, DEVICE_B))];
      applyAsVersion1(c, reels);
      server.push(reels);
      server.push(changedItems(a.settings, a.clocks, server.known).items);
      a = applied(applyRemoteItems(a.settings, a.clocks, server.all));
      applyAsVersion1(c, server.all);
      // C updates: what it holds goes to the server once, and A takes it.
      const updated = update(c, DEVICE_B);
      server.push(changedItems(updated.settings, updated.clocks, server.known).items);
      a = applied(applyRemoteItems(a.settings, a.clocks, server.all));
      expect([storedOnA, a.settings.platforms.facebook]).toEqual([storedOnA, updated.settings.platforms.facebook]);
      expect(presetOf('facebook', a.settings.platforms.facebook)).toBe('custom');
    }
  });

  it('test_the_upgrade_is_sent_once_and_devices_never_fight_over_it', () => {
    // Both computers picked Calm, then Balanced, on version 1; the server holds those items.
    const server = new Server();
    const old = balancedFromVersion1(hlc(1));
    server.push(old);
    // Both update to version 2: each reads Balanced with the rule and sends it once; the second finds it already sent
    // or sends the same value, and neither has anything more to send.
    let a = update(onVersion1(old), DEVICE_A);
    let b = update(onVersion1(old), DEVICE_B);
    for (const device of [a, b]) {
      expect(notFollowed(device.settings)).toBe(true);
      server.push(changedItems(device.settings, device.clocks, server.known).items);
    }
    expect(server.items.get(NF)).toMatchObject({ value: true });
    ({ settings: a.settings, clocks: a.clocks } = applied(applyRemoteItems(a.settings, a.clocks, server.all)));
    ({ settings: b.settings, clocks: b.clocks } = applied(applyRemoteItems(b.settings, b.clocks, server.all)));
    for (const device of [a, b]) expect(changedItems(device.settings, device.clocks, server.known).items).toEqual([]);
    expect(a.settings).toEqual(b.settings);

    // A third computer, still on version 1, picks Balanced again: both read it the same way, and send nothing back.
    const again = balancedFromVersion1(hlc(9, DEVICE_B));
    server.push(again);
    const onA = applied(applyRemoteItems(a.settings, a.clocks, again));
    const onB = applied(applyRemoteItems(b.settings, b.clocks, again));
    for (const r of [onA, onB]) {
      expect(notFollowed(r.settings)).toBe(true);
      expect(changedItems(r.settings, r.clocks, server.known).items).toEqual([]);
    }
    expect(onA.settings).toEqual(onB.settings);
    a = { settings: onA.settings, clocks: onA.clocks };
    b = { settings: onB.settings, clocks: onB.clocks };

    // The person turns the rule off on A: one round trip, and B agrees; nothing echoes.
    a = edit(a.settings, a.clocks, DEVICE_A, 10, (s) => void (s.platforms.facebook.filters.notFollowed = false));
    const sent = changedItems(a.settings, a.clocks, server.known).items;
    expect(sent.map((item) => [item.key, item.deleted ? null : item.value])).toEqual([
      [`${FB}.preset`, 'custom'],
      [NF, false],
    ]);
    server.push(sent);
    const bAfter = applied(applyRemoteItems(b.settings, b.clocks, sent));
    expect(notFollowed(bAfter.settings)).toBe(false);
    expect(bAfter.settings.platforms.facebook).toEqual(a.settings.platforms.facebook);
    expect(changedItems(bAfter.settings, bAfter.clocks, server.known).items).toEqual([]);
    // An older pick from the version 1 computer doesn't undo it; a newer one is the person choosing Balanced again.
    expect(
      notFollowed(applied(applyRemoteItems(bAfter.settings, bAfter.clocks, balancedFromVersion1(hlc(8, DEVICE_B)))).settings),
    ).toBe(false);
    const picked = applied(applyRemoteItems(bAfter.settings, bAfter.clocks, balancedFromVersion1(hlc(11, DEVICE_B))));
    expect(presetOf('facebook', picked.settings.platforms.facebook)).toBe('balanced');
  });

  it('test_light_and_calm_from_any_version_arrive_as_sent', () => {
    for (const preset of ['light', 'calm'] as const) {
      const values = applyPreset('facebook', defaultSettings().platforms.facebook, preset);
      const batch = [
        live(`${FB}.preset`, preset, hlc(3, DEVICE_B)),
        ...Object.entries(values.filters).map(([k, v]) => live(`${FB}.filters.${k}`, v, hlc(3, DEVICE_B))),
      ];
      const result = applied(applyRemoteItems(defaultSettings(), {}, batch));
      expect(result.settings.platforms.facebook.filters).toEqual(values.filters);
    }
  });
});

describe('resync', () => {
  it('test_drop_after_resync_uses_gc_floor', () => {
    const s = defaultSettings();
    s.display.mode = 'hide';
    s.interests.more.old = topic('Old');
    s.interests.more.recent = topic('Recent');
    s.interests.more.onServer = topic('On the server');
    s.platforms.facebook.alwaysHide.rule = { label: 'Ann Example', match: 'fb:ann', addedAt: 1 };
    // Entries changedItems never sends never reached the server, so no other device deleted them.
    s.interests.muteWords.withheld = { label: `mute ${ANT_KEY}`, addedAt: 1 };
    s.interests.less.invalid = topic('Ann \uD83D');
    const clocks: SettingsClocks = {
      'display.mode': day(10),
      'interests.more.old.label': day(10),
      'interests.more.recent': day(120),
      'interests.more.onServer': day(10),
      'platforms.facebook.alwaysHide.rule': day(100),
      // A local delete the server never saw: a tombstone, re-sent.
      'interests.more.deleted': day(10),
      'interests.muteWords.withheld': day(10),
      'interests.less.invalid': day(10),
      // Added while this computer could not sync, before the newest cleaned-up deletion: it never reached the server.
      'interests.more.offline': day(20),
    };
    s.interests.more.offline = topic('Made offline');
    const serverKeys = new Set(['interests.more.onServer', 'interests.less.cleaned']);
    // What the server held before it started over: every entry here but the one made offline.
    const wasKnown = new Set(Object.keys(normalizeClocks(s, clocks)).filter((k) => k !== 'interests.more.offline'));

    const result = dropAfterResync(s, clocks, serverKeys, day(100), wasKnown);
    expect(result.dropped.sort()).toEqual(['interests.more.old', 'platforms.facebook.alwaysHide.rule']);
    expect(Object.keys(result.settings.interests.more).sort()).toEqual(['offline', 'onServer', 'recent']);
    expect(result.settings.platforms.facebook.alwaysHide).toEqual({});
    expect(result.settings.display.mode).toBe('hide');
    expect(result.settings.interests.muteWords.withheld).toEqual(s.interests.muteWords.withheld);
    expect(result.settings.interests.less.invalid).toEqual(topic('Ann \uD83D'));
    expect(result.clocks).toEqual({
      'display.mode': day(10),
      'interests.more.recent': day(120),
      'interests.more.onServer': day(10),
      'interests.more.deleted': day(10),
      'interests.muteWords.withheld': day(10),
      'interests.less.invalid': day(10),
      'interests.more.offline': day(20),
    });
    // Dropped entries are neither kept nor sent; the rest still is, and the kept local-only entries stay unsent.
    const after = changedItems(result.settings, result.clocks, {});
    expect(after.items.map((item) => item.key)).toEqual([
      'display.mode',
      'interests.more.recent',
      'interests.more.onServer',
      'interests.more.deleted',
      'interests.more.offline',
    ]);
    expect(after.withheld).toEqual(['interests.muteWords.withheld']);
    // Pure: the inputs are left as they were.
    expect(s.interests.more.old).toEqual(topic('Old'));

    // A brand-new space has no cleaned-up tombstones: nothing is dropped.
    const fresh = dropAfterResync(s, clocks, new Set(), HLC_ZERO, wasKnown);
    expect(fresh.dropped).toEqual([]);
    expect(fresh.settings).toEqual(s);
    expect(fresh.clocks).toEqual(normalizeClocks(s, clocks));
  });
});
