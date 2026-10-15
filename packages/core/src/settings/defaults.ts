import type { PlatformId } from '@unalgorithm/protocol';
import { presetValues } from '../presets.ts';
import { type Device, type PlatformSettings, type Preset, SETTINGS_VERSION, type Settings } from './schema.ts';

export function defaultPlatformSettings(platform: PlatformId, preset: Preset = 'balanced'): PlatformSettings {
  const v = presetValues(platform, preset);
  return { enabled: true, preset, filters: v.filters, ai: v.ai, alwaysShow: {}, alwaysHide: {} };
}

/** Fresh-install settings: Balanced on both platforms, collapse display, no interests, no AI. */
export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    platforms: {
      linkedin: defaultPlatformSettings('linkedin'),
      facebook: defaultPlatformSettings('facebook'),
    },
    display: {
      mode: 'collapse',
      showReason: true,
      showAuthor: true,
      groupRuns: true,
      forYou: 'ring',
      badgeCount: true,
      tips: true,
    },
    interests: { more: {}, less: {}, about: '', highlightWords: {}, muteWords: {} },
    highlights: { enabled: true, amount: 'standard' },
    ai: { relevanceCutoff: 35, dailyCap: 300, redactMentions: true, learnFromFeedback: true },
  };
}

export function defaultDevice(deviceId: string): Device {
  return {
    version: 1,
    deviceId,
    aiSource: null,
    onboarding: {
      completedAt: null,
      step: null,
      setupBannerDismissed: false,
      coachMarkShown: { linkedin: false, facebook: false },
    },
    pausedUntil: { linkedin: null, facebook: null },
    dev: { debugOverlay: false },
    labs: { factcheck: false },
  };
}
