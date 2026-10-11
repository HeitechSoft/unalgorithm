import { applyPreset, presetOf, type Settings } from '@unalgorithm/core';
import type { SettingsAction } from '../lib/messages.ts';
import { updateSettings } from '../lib/settings-store.ts';

/** Apply an in-feed settings change and return the action that undoes it. */
export async function applySettingsAction(action: SettingsAction): Promise<SettingsAction | null> {
  let undo: SettingsAction | null = null;
  await updateSettings((s: Settings) => {
    switch (action.op) {
      case 'setFilter': {
        const ps = s.platforms[action.platform];
        undo = { ...action, value: ps.filters[action.key] };
        ps.filters[action.key] = action.value;
        ps.preset = presetOf(action.platform, ps);
        return;
      }
      case 'setNoise': {
        const ps = s.platforms[action.platform];
        undo = { ...action, value: ps.ai.noise[action.label] };
        ps.ai.noise[action.label] = action.value;
        ps.preset = presetOf(action.platform, ps);
        return;
      }
      case 'setLowRelevance': {
        const ps = s.platforms[action.platform];
        undo = { ...action, value: ps.ai.lowRelevance };
        ps.ai.lowRelevance = action.value;
        ps.preset = presetOf(action.platform, ps);
        return;
      }
      case 'addPersonRule':
        s.platforms[action.platform][action.list][action.id] = action.rule;
        undo = { op: 'removePersonRule', platform: action.platform, list: action.list, id: action.id };
        return;
      case 'removePersonRule': {
        const rule = s.platforms[action.platform][action.list][action.id];
        if (rule) undo = { op: 'addPersonRule', platform: action.platform, list: action.list, id: action.id, rule };
        delete s.platforms[action.platform][action.list][action.id];
        return;
      }
      case 'addTopic':
        s.interests[action.list][action.id] = action.topic;
        undo = { op: 'removeTopic', list: action.list, id: action.id };
        return;
      case 'removeTopic': {
        const topic = s.interests[action.list][action.id];
        if (topic) undo = { op: 'addTopic', list: action.list, id: action.id, topic };
        delete s.interests[action.list][action.id];
        return;
      }
      case 'setPreset': {
        const before = s.platforms[action.platform].preset;
        s.platforms[action.platform] = applyPreset(action.platform, s.platforms[action.platform], action.preset);
        if (before !== 'custom') undo = { op: 'setPreset', platform: action.platform, preset: before };
        return;
      }
      case 'setPlatformEnabled':
        undo = { ...action, value: s.platforms[action.platform].enabled };
        s.platforms[action.platform].enabled = action.value;
        return;
    }
  });
  return undo;
}
