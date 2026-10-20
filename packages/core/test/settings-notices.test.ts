import { NOTICE_KINDS, PLATFORMS } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import {
  type Device,
  DeviceSchema,
  defaultDevice,
  defaultSettings,
  migrateDevice,
  NoticePrefsSchema,
  noticeSnoozeKey,
  SettingsSchema,
} from '../src/index.ts';

/** A device as stored before ADR 0009: everything but `notices`. */
function storedBefore(): Record<string, unknown> {
  const { notices: _notices, ...rest } = defaultDevice('d1');
  return { ...rest, pausedUntil: { linkedin: 'manual', facebook: 5 }, labs: { factcheck: true, perspectives: false } };
}

describe('device notices (ADR 0009 §3)', () => {
  it('test_default_device_tells_when_something_breaks', () => {
    expect(defaultDevice('d1').notices).toStrictEqual({ enabled: true, snoozed: {} });
    expect(DeviceSchema.safeParse(defaultDevice('d1')).success).toBe(true);
  });

  it('test_existing_devices_get_notices_and_keep_everything_else', () => {
    const stored = storedBefore();
    const out = migrateDevice(stored, () => 'new');
    expect(out.notices).toStrictEqual({ enabled: true, snoozed: {} });
    const { notices: _notices, ...rest } = out;
    expect(rest).toStrictEqual(stored);
  });

  it('test_snoozes_survive_and_broken_ones_reset_alone', () => {
    const until = Date.UTC(2026, 9, 19, 12);
    const notices: Device['notices'] = {
      enabled: false,
      snoozed: {
        [noticeSnoozeKey('linkedin', 'ads-through')]: { until, adapter: 'linkedin@2026.11.0' },
        [noticeSnoozeKey('facebook', 'paused')]: { until: until + 1, adapter: 'facebook@2026.11.0' },
      },
    };
    const kept = migrateDevice({ ...storedBefore(), notices }, () => 'new');
    expect(kept.notices).toStrictEqual(notices);
    // A snooze from a newer version with a field this one doesn't know keeps it.
    const newer = { enabled: true, snoozed: { 'linkedin:paused': { until, adapter: 'linkedin@2026.11.0', count: 2 } } };
    expect(migrateDevice({ ...storedBefore(), notices: newer }, () => 'new').notices).toStrictEqual(newer);
    // A broken snooze list resets the snoozes, never the switch or the rest of the device.
    const broken = migrateDevice(
      { ...storedBefore(), notices: { enabled: false, snoozed: { 'Jane Doe': { until: 'tomorrow' } } } },
      () => 'new',
    );
    expect(broken.notices).toStrictEqual({ enabled: false, snoozed: {} });
    expect(broken.labs).toStrictEqual({ factcheck: true, perspectives: false });
    const switchBroken = migrateDevice({ ...storedBefore(), notices: { enabled: 'yes', snoozed: {} } }, () => 'new');
    expect(switchBroken.notices.enabled).toBe(true);
    expect(migrateDevice({ ...storedBefore(), notices: 'off' }, () => 'new').notices).toStrictEqual({
      enabled: true,
      snoozed: {},
    });
  });

  it('test_snooze_keys', () => {
    expect(noticeSnoozeKey('linkedin', 'ads-through')).toBe('linkedin:ads-through');
    for (const platform of PLATFORMS) {
      for (const kind of NOTICE_KINDS) {
        const prefs = {
          enabled: true,
          snoozed: { [noticeSnoozeKey(platform, kind)]: { until: 1, adapter: `${platform}@2026.11.0` } },
        };
        expect(NoticePrefsSchema.safeParse(prefs).success, `${platform}:${kind}`).toBe(true);
      }
    }
    for (const key of ['linkedin', 'linkedin:', ':paused', 'LinkedIn:paused', 'linkedin:ads through']) {
      const prefs = { enabled: true, snoozed: { [key]: { until: 1, adapter: 'linkedin@2026.11.0' } } };
      expect(NoticePrefsSchema.safeParse(prefs).success, key).toBe(false);
    }
    // zod drops a `__proto__` key before checking it: it is never kept.
    const proto = NoticePrefsSchema.parse(JSON.parse('{"enabled":true,"snoozed":{"__proto__":{"until":1,"adapter":"x"}}}'));
    expect(Object.getOwnPropertyNames(proto.snoozed)).toEqual([]);
  });

  it('test_notices_never_sync', () => {
    // Device state is never synced or exported; the synced settings have no notices, so snoozes stay on this browser.
    expect(Object.keys(SettingsSchema.shape)).not.toContain('notices');
    expect(JSON.stringify(defaultSettings())).not.toContain('notices');
    expect(Object.keys(DeviceSchema.shape)).toContain('notices');
  });
});
