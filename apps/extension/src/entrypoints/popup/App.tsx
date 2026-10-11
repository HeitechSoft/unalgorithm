import { dateKey, isPaused, type Preset, presetOf } from '@unalgorithm/core';
import type { PlatformId } from '@unalgorithm/protocol';
import {
  Banner,
  BriefcaseBusiness,
  Button,
  ChevronRight,
  Chip,
  CircleHelp,
  Cpu,
  Eye,
  IconButton,
  ListGroup,
  ListRow,
  Lockup,
  MessageSquareWarning,
  PanelRight,
  SegmentedControl,
  Settings,
  Switch,
  Tile,
  UsersRound,
} from '@unalgorithm/ui';
import { useState } from 'react';
import { browser } from 'wxt/browser';
import {
  FEED_URLS,
  platformOfUrl,
  useActiveTab,
  useAiStatus,
  useDevice,
  useSettings,
  useStorageItem,
  useTabState,
} from '../../lib/hooks.ts';
import { sendQuietly, sendToBackground, sendToTab } from '../../lib/messages.ts';
import { statsItem } from '../../lib/storage.ts';

const SITE: Record<PlatformId, string> = { linkedin: 'LinkedIn', facebook: 'Facebook' };
const NEW_ISSUE = 'https://github.com/HeitechSoft/unalgorithm/issues/new/choose';
const STRENGTHS = [
  { value: 'light', label: 'Light' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'calm', label: 'Calm' },
] as const;

function openSettings(hash = '') {
  void browser.tabs.create({ url: browser.runtime.getURL('/options.html') + hash });
  window.close();
}

export function App() {
  const tab = useActiveTab();
  const tabState = useTabState(tab?.id);
  const [settings, saveSettings] = useSettings();
  const [device, saveDevice] = useDevice();
  const ai = useAiStatus(JSON.stringify(device?.aiSource ?? null));
  const stats = useStorageItem(statsItem, {});
  const [peek, setPeek] = useState(false);
  const platform = tab ? platformOfUrl(tab.url) : null;

  if (!settings || !device) return null;
  const today = stats[dateKey()]?.hidden ?? 0;

  const openPanel = () => {
    if (tab) void browser.sidePanel.open({ windowId: tab.windowId });
    window.close();
  };

  // The content script builds the report: it holds the page's (content-free) diagnostics.
  const reportProblem = async () => {
    const res = tab ? await sendToTab(tab.id, { type: 'reportUrl' }) : undefined;
    await browser.tabs.create({ url: res?.url ?? NEW_ISSUE });
    window.close();
  };

  const setupBanner =
    !device.onboarding.completedAt && !device.onboarding.setupBannerDismissed ? (
      <Banner
        title="Finish setup, about a minute"
        action={{ label: 'Continue', onAction: () => sendQuietly({ type: 'openPage', page: 'onboarding' }) }}
        onDismiss={() => void saveDevice((d) => void (d.onboarding.setupBannerDismissed = true))}
      />
    ) : null;

  const header = (
    <header className="ua-hstack" style={{ justifyContent: 'space-between', padding: '4px 4px 12px' }}>
      <Lockup size={26} />
      <span className="ua-hstack" style={{ gap: 2 }}>
        <IconButton icon={PanelRight} label="Open Highlights" onClick={openPanel} />
        <IconButton icon={Settings} label="Settings" onClick={() => openSettings()} />
      </span>
    </header>
  );

  const footer = (
    <footer className="ua-hstack ua-footnote" style={{ justifyContent: 'space-between', padding: '4px 6px 0', minHeight: 32 }}>
      <button
        type="button"
        className="ua-button ua-button--plain ua-button--sm"
        onClick={() => openSettings('#/ai')}
        style={{ paddingInline: 4 }}
      >
        <Cpu aria-hidden="true" />
        {ai?.configured ? `${ai.label} · ${ai.state === 'ready' ? 'Ready' : 'Needs attention'}` : 'AI off · rules only'}
      </button>
      <span className="ua-hstack" style={{ gap: 12 }}>
        {platform ? (
          <button
            type="button"
            className="ua-button ua-button--plain ua-button--sm"
            onClick={() => void reportProblem()}
            style={{ paddingInline: 4 }}
          >
            <MessageSquareWarning aria-hidden="true" /> Report a problem
          </button>
        ) : null}
        <a
          href="https://github.com/HeitechSoft/unalgorithm#readme"
          target="_blank"
          rel="noreferrer"
          className="ua-hstack"
          style={{ gap: 4 }}
        >
          <CircleHelp size={14} aria-hidden="true" /> Help
        </a>
      </span>
    </footer>
  );

  // Not on a supported site: both platforms, today's total, quick links.
  if (!platform) {
    return (
      <main className="popup" data-density="compact">
        {header}
        <div className="ua-stack">
          {setupBanner}
          <ListGroup footer={`Today: ${today} post${today === 1 ? '' : 's'} hidden`}>
            {(['linkedin', 'facebook'] as const).map((p) => (
              <ListRow
                key={p}
                icon={{ icon: p === 'linkedin' ? BriefcaseBusiness : UsersRound, tint: p === 'linkedin' ? 'blue' : 'indigo' }}
                title={SITE[p]}
                subtitle={
                  settings.platforms[p].enabled
                    ? `${presetOf(p, settings.platforms[p]).replace(/^./, (c) => c.toUpperCase())}${isPaused(device, p) ? ' · paused' : ''}`
                    : 'Off'
                }
                control={
                  <Button size="sm" variant="tinted" href={FEED_URLS[p]}>
                    Open
                  </Button>
                }
              />
            ))}
          </ListGroup>
        </div>
        {footer}
      </main>
    );
  }

  const ps = settings.platforms[platform];
  const paused = isPaused(device, platform);
  const on = ps.enabled && !paused;
  const preset = presetOf(platform, ps);
  const hidden = tabState.counts.hiddenTotal;
  const chips = Object.entries(tabState.counts.hidden).sort((a, b) => b[1] - a[1]);

  const setOn = async (v: boolean) => {
    if (!ps.enabled && v) await saveSettings((s) => void (s.platforms[platform].enabled = true));
    await sendToBackground({ type: 'pause', platform, until: v ? null : 'manual' });
  };
  const pauseFor = (ms: number | 'manual') =>
    sendQuietly({ type: 'pause', platform, until: ms === 'manual' ? 'manual' : Date.now() + ms });

  return (
    <main className="popup" data-density="compact">
      {header}
      <div className="ua-stack">
        {setupBanner}
        {tabState.health.status === 'broken' && on ? (
          <Banner
            tone="warning"
            title="Filtering is paused on this page"
            action={{ label: 'Report a problem', onAction: () => void reportProblem() }}
          >
            {SITE[platform]}'s layout looks different, and we'd rather show everything than hide posts by mistake.
          </Banner>
        ) : null}
        {tabState.health.status === 'unsupported-locale' && on ? (
          <Banner title={`${SITE[platform]} isn't in English`}>
            UnAlgorithm reads English labels, so most filters can't run on this page yet.
          </Banner>
        ) : null}
        <div className="ua-card">
          <ListRow
            icon={{
              icon: platform === 'linkedin' ? BriefcaseBusiness : UsersRound,
              tint: platform === 'linkedin' ? 'blue' : 'indigo',
            }}
            title={SITE[platform]}
            subtitle={on ? 'Cleaning up your feed' : paused ? 'Paused. Posts show as the site sends them.' : 'Off'}
            control={<Switch checked={on} onCheckedChange={(v) => void setOn(v)} label={`UnAlgorithm on ${SITE[platform]}`} />}
          />
          {paused ? (
            <div className="ua-hstack ua-wrap ua-footnote" style={{ padding: '0 16px 12px', gap: 6 }}>
              Turn back on:
              <Button size="sm" variant="secondary" onClick={() => pauseFor(3_600_000)}>
                In 1 hour
              </Button>
              <Button size="sm" variant="secondary" onClick={() => pauseFor(tomorrowMs())}>
                Tomorrow
              </Button>
              <Button size="sm" variant="secondary" onClick={() => pauseFor('manual')}>
                Manually
              </Button>
            </div>
          ) : null}
          {on ? (
            <div style={{ padding: '4px 16px 16px', borderTop: '0.5px solid var(--ua-separator)' }}>
              {tabState.onFeed ? (
                <>
                  <div className="ua-hstack" style={{ alignItems: 'baseline', gap: 8, padding: '8px 0 2px' }}>
                    <span className="ua-stat">{hidden}</span>
                    <span className="ua-secondary">post{hidden === 1 ? '' : 's'} hidden on this page</span>
                  </div>
                  <div className="ua-footnote" style={{ marginBottom: 10 }}>
                    {today} today
                  </div>
                  {chips.length ? (
                    <div className="ua-hstack ua-wrap" style={{ gap: 6, marginBottom: 14 }}>
                      {chips.slice(0, 4).map(([key, n]) => (
                        <Chip
                          key={key}
                          size="sm"
                          label={tabState.reasonLabels[key] ?? key}
                          count={n}
                          onClick={openPanel}
                          ai={key.startsWith('noise') || key === 'low-relevance'}
                        />
                      ))}
                      {chips.length > 4 ? <Chip size="sm" label={`+${chips.length - 4}`} onClick={openPanel} /> : null}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="ua-hstack" style={{ justifyContent: 'space-between', padding: '10px 0 14px' }}>
                  <span className="ua-secondary ua-callout">UnAlgorithm works on your home feed.</span>
                  <Button size="sm" variant="tinted" href={FEED_URLS[platform]}>
                    Go to feed
                  </Button>
                </div>
              )}
              <div className="ua-headline" style={{ marginBottom: 6 }}>
                Strength
              </div>
              <SegmentedControl<Preset>
                fullWidth
                label="Strength"
                value={preset === 'custom' ? null : preset}
                customLabel="Custom"
                options={STRENGTHS}
                onValueChange={(v) => sendQuietly({ type: 'settingsAction', action: { op: 'setPreset', platform, preset: v } })}
              />
            </div>
          ) : null}
        </div>
        {on && tabState.onFeed ? (
          <ListGroup>
            <ListRow
              leading={
                <span
                  className="ua-foryou-dot"
                  style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--ua-accent)' }}
                />
              }
              title={`${tabState.counts.highlighted} post${tabState.counts.highlighted === 1 ? '' : 's'} for you`}
              accessory={<ChevronRight aria-hidden="true" />}
              onSelect={openPanel}
            />
            <ListRow
              leading={<Tile icon={Eye} tint="gray" size="sm" />}
              title="Peek at hidden posts"
              subtitle="This page only"
              control={
                <Switch
                  size="sm"
                  checked={peek}
                  label="Peek at hidden posts"
                  onCheckedChange={(v) => {
                    setPeek(v);
                    if (tab) void sendToTab(tab.id, { type: 'peek', on: v });
                  }}
                />
              }
            />
          </ListGroup>
        ) : null}
      </div>
      {footer}
    </main>
  );
}

function tomorrowMs(): number {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  t.setHours(6, 0, 0, 0);
  return t.getTime() - Date.now();
}
