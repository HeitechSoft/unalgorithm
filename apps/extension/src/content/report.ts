import type { PlatformAdapter } from '@unalgorithm/platforms';
import { SOURCE_REPO } from '@unalgorithm/protocol';
import { browser } from 'wxt/browser';
import { browserVersion } from '../lib/browser-kind.ts';
import type { FeedController } from './feed-controller.ts';

/**
 * A prefilled GitHub issue for a detection problem. Contains only versions (the browser's name and major version, e.g.
 * "Firefox 147"), counts and detector names: never post text, names, ids or URLs. The user reviews it and submits it
 * themselves.
 */
export function reportProblemUrl(adapter: PlatformAdapter, controller: FeedController): string {
  const d = controller.diagnostics();
  const diagnostics = {
    extension: browser.runtime.getManifest().version,
    adapter: adapter.version,
    browser: browserVersion(navigator.userAgent),
    lang: (document.documentElement.lang || 'unknown').slice(0, 8),
    health: controller.getHealth(),
    counts: d.counts,
    detectors: d.detectors,
    landmarks: d.landmarks,
    date: new Date().toISOString().slice(0, 10),
  };
  const params = new URLSearchParams({
    template: 'broken_layout.yml',
    title: `[${adapter.id}] Filtering looks wrong`,
    platform: adapter.id === 'facebook' ? 'Facebook' : 'LinkedIn',
    diagnostics: JSON.stringify(diagnostics, null, 1).slice(0, 2000),
  });
  return `${SOURCE_REPO}/issues/new?${params.toString()}`;
}
