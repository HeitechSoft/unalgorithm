import { balanceLine, dateKey, isPaused, type Preset, presetOf } from '@unalgorithm/core';
import { type NoticeKind, PLATFORM_NAMES } from '@unalgorithm/protocol';
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
  NOTICE_ACTIONS,
  noticeCopy,
  PanelRight,
  SegmentedControl,
  Settings,
  Switch,
  Tile,
  UsersRound,
} from '@unalgorithm/ui';
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { BalancePill, shouldShowLowBalance } from '../../components/BalancePill.tsx';
import {
  type ActiveTab,
  FEED_URLS,
  platformOfUrl,
  useActiveTab,
  useAiStatus,
  useDevice,
  useSettings,
  useStorageItem,
  useTabState,
} from '../../lib/hooks.ts';
import { type AiStatus, sendQuietly, sendToBackground, sendToTab } from '../../lib/messages.ts';
import { lowBalanceNoticeItem, statsItem } from '../../lib/storage.ts';

const SITE = PLATFORM_NAMES;
/** How long the popup waits for the tab's content script before saying it isn't running (ADR 0009 §3). */
export const PING_WAIT_MS = 1500;
/** The popup's own words for a page unAlgorithm isn't on or isn't running on (ADR 0009 §3). */
export const POPUP_COPY = {
  noScript: {
    title: "unAlgorithm isn't running on this page",
    body: 'Reloading the page usually fixes this.',
    reload: 'Reload page',
    report: 'Still not working? Let us know',
  },
  feedLike: "unAlgorithm isn't running on this feed.",
  noAds: 'No ads found on this page yet.',
  report: 'Report a problem',
} as const;
const STRENGTHS = [
  { value: 'light', label: 'Light' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'calm', label: 'Calm' },
] as const;

function openSettings(hash = '') {
  void browser.tabs.create({ url: browser.runtime.getURL('/options.html') + hash });
  window.close();
}

/**
 * Whether the low-balance banner shows: at most once a local day (R31). The stamp is read once, not watched (stamping
 * would then hide the banner a moment after it showed); the answer is decided once both the stamp and `ai` are in, and
 * kept; only then is today stamped, whether or not the banner is dismissed. Dismissing hides it until the popup closes.
 */
function useLowBalanceNotice(ai: AiStatus | undefined): [boolean, () => void] {
  /** undefined until read; a stamp that can't be read never shows the banner. */
  const [stamp, setStamp] = useState<string | null>();
  const [show, setShow] = useState<boolean>();
  useEffect(() => {
    let alive = true;
    lowBalanceNoticeItem
      .getValue()
      .then((on) => alive && setStamp(on))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (show === undefined && ai && stamp !== undefined) setShow(shouldShowLowBalance(ai.balance, stamp, dateKey()));
  }, [ai, stamp, show]);
  useEffect(() => {
    if (show) void lowBalanceNoticeItem.setValue(dateKey()).catch(() => undefined);
  }, [show]);
  return [show === true, () => setShow(false)];
}

/**
 * Whether the tab's content script is running: `silent` when a LinkedIn or Facebook tab that has finished loading, and
 * has no state from unAlgorithm, gave no answer to a ping within 1.5 s (`no-content-script`). Anything else is
 * `running` or still `unknown`.
 */
function useScriptState(tab: ActiveTab | undefined, onPlatform: boolean, hasState: boolean): 'unknown' | 'running' | 'silent' {
  const [state, setState] = useState<'unknown' | 'running' | 'silent'>('unknown');
  const tabId = tab?.id;
  useEffect(() => {
    if (tabId === undefined || !onPlatform) return;
    let alive = true;
    let answered = false;
    setState('unknown');
    void sendToTab(tabId, { type: 'ping' }).then((res) => {
      answered = !!res;
      if (alive && res) setState('running');
    });
    const timer = setTimeout(() => {
      if (answered) return;
      void browser.tabs
        .get(tabId)
        .then((t) => alive && !answered && setState(t.status === 'complete' ? 'silent' : 'unknown'))
        .catch(() => undefined);
    }, PING_WAIT_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [tabId, onPlatform]);
  return state === 'silent' && hasState ? 'unknown' : state;
}

export function App() {
  const tab = useActiveTab();
  const tabState = useTabState(tab?.id);
  const [settings, saveSettings] = useSettings();
  const [device, saveDevice] = useDevice();
  const ai = useAiStatus(JSON.stringify(device?.aiSource ?? null));
  const stats = useStorageItem(statsItem, {});
  const [peek, setPeek] = useState(false);
  const [lowBalance, dismissLowBalance] = useLowBalanceNotice(ai);
  const [copied, setCopied] = useState<string | null>(null);
  const platform = tab ? platformOfUrl(tab.url) : null;
  const script = useScriptState(tab, !!platform, tabState.updatedAt > 0);
  const devBuild = import.meta.env.MODE !== 'production';

  if (!settings || !device) return null;
  const today = stats[dateKey()]?.hidden ?? 0;
  const balance = ai?.balance;

  // Only the account page the background allows (CL2-10).
  const openAccount = () => {
    if (!balance?.accountUrl) return;
    void browser.tabs.create({ url: balance.accountUrl });
    window.close();
  };
  const addCredit = balance?.accountUrl ? { label: 'Add credit', onAction: openAccount } : undefined;

  // R27: AI is paused while the balance is empty. A state, not a promotion: shown whenever it holds, never dismissed.
  const creditBanners = (
    <>
      {balance?.empty ? (
        <Banner tone="warning" title="AI is paused" action={addCredit}>
          {ai?.message ? <p>{ai.message}</p> : null}
          <Button variant="plain" size="sm" onClick={() => openSettings('#/ai')} style={{ marginInlineStart: -8 }}>
            Switch AI
          </Button>
        </Banner>
      ) : null}
      {lowBalance && balance?.low ? (
        <Banner tone="info" title="Your balance is low" action={addCredit} onDismiss={dismissLowBalance}>
          {balanceLine(balance.balanceMicros, new Date(), undefined, balance.microsPer1000Posts)}
        </Banner>
      ) : null}
    </>
  );

  // Straight from the click, before the popup closes: Firefox opens its sidebar (in this window) only then.
  const openPanel = () => {
    const sidebar = browser.sidebarAction;
    if (sidebar) void sidebar.open().catch(() => undefined);
    else if (tab) void browser.sidePanel.open({ windowId: tab.windowId });
    window.close();
  };

  // The content script builds the report's draft where it runs: it holds the page's facts (counts and codes, never
  // content). Without an answer, or off LinkedIn and Facebook, the background builds one without them. Either way the
  // report page opens, and nothing is sent until the person sends it there (ADR 0009 §2).
  const reportProblem = async (from: 'popup' | 'popup-banner' | 'popup-no-script' = 'popup') => {
    const snapshot =
      tab && platform && from !== 'popup-no-script'
        ? await sendToTab(tab.id, { type: 'reportSnapshot', from: from === 'popup-banner' ? 'popup-banner' : 'popup' })
        : undefined;
    if (!snapshot?.ok) {
      await sendToBackground({
        type: 'openReport',
        about: { from: from === 'popup-no-script' ? 'popup-no-script' : 'popup', platform, tabId: tab?.id ?? null },
      }).catch(() => undefined);
    }
    window.close();
  };
  const reloadTab = () => {
    if (tab) void browser.tabs.reload(tab.id);
    window.close();
  };

  // Development builds: copy this page's content-free diagnostics (versions, counts, detector hits) for a bug report.
  const copyDiagnostics = async () => {
    const d = tab ? await sendToTab(tab.id, { type: 'diagnostics' }) : undefined;
    if (!d) return setCopied('Reload the feed tab first');
    await navigator.clipboard.writeText(JSON.stringify({ ...d, hidden: tabState.counts }, null, 1));
    setCopied('Copied');
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
    <footer
      className="ua-hstack ua-footnote"
      style={{ justifyContent: 'space-between', flexWrap: 'wrap', padding: '4px 6px 0', minHeight: 32 }}
    >
      <span className="ua-hstack ua-wrap" style={{ gap: 4 }}>
        <button
          type="button"
          className="ua-button ua-button--plain ua-button--sm"
          onClick={() => openSettings('#/ai')}
          style={{ paddingInline: 4 }}
        >
          <Cpu aria-hidden="true" />
          {ai?.configured ? `${ai.label} · ${ai.state === 'ready' ? 'Ready' : 'Needs attention'}` : 'AI off · rules only'}
        </button>
        {balance ? <BalancePill balance={balance} onOpen={openAccount} /> : null}
      </span>
      <span className="ua-hstack" style={{ gap: 12 }}>
        <button
          type="button"
          className="ua-button ua-button--plain ua-button--sm"
          onClick={() => void reportProblem(script === 'silent' ? 'popup-no-script' : 'popup')}
          style={{ paddingInline: 4 }}
        >
          <MessageSquareWarning aria-hidden="true" /> {POPUP_COPY.report}
        </button>
        <a href="https://unalgorithmfeed.com/help/" target="_blank" rel="noreferrer" className="ua-hstack" style={{ gap: 4 }}>
          <CircleHelp size={14} aria-hidden="true" /> Help
        </a>
      </span>
      {devBuild && platform ? (
        <button
          type="button"
          className="ua-button ua-button--plain ua-button--sm"
          onClick={() => void copyDiagnostics()}
          style={{ paddingInline: 4, flexBasis: '100%', justifyContent: 'flex-start' }}
        >
          {copied ?? 'Developer: copy diagnostics'}
        </button>
      ) : null}
    </footer>
  );

  // Not on a supported site: both platforms, today's total, quick links.
  if (!platform) {
    return (
      <main className="popup" data-density="compact">
        {header}
        <div className="ua-stack">
          {creditBanners}
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
  // The in-feed card's notice, whatever its snoozes (ADR 0009 §3); else the paused banner when health broke without one.
  const notice: NoticeKind | undefined = tabState.notice?.kind ?? (tabState.health.status === 'broken' ? 'paused' : undefined);
  const noticeText = notice ? noticeCopy(notice, tabState.notice?.issues ?? tabState.health.issues) : undefined;
  const noAds = tabState.onFeed && tabState.health.issues.includes('no-ads-seen');
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
        {creditBanners}
        {setupBanner}
        {script === 'silent' && on ? (
          <Banner
            tone="warning"
            title={POPUP_COPY.noScript.title}
            action={{ label: POPUP_COPY.noScript.reload, onAction: reloadTab }}
          >
            <p>{POPUP_COPY.noScript.body}</p>
            <Button
              variant="plain"
              size="sm"
              onClick={() => void reportProblem('popup-no-script')}
              style={{ marginInlineStart: -8 }}
            >
              {POPUP_COPY.noScript.report}
            </Button>
          </Banner>
        ) : notice && noticeText && on ? (
          <Banner
            tone={notice === 'ads-through' ? 'info' : 'warning'}
            title={noticeText.title}
            action={{ label: NOTICE_ACTIONS.report, onAction: () => void reportProblem('popup-banner') }}
          >
            {noticeText.body(SITE[platform])}
          </Banner>
        ) : null}
        {tabState.health.status === 'unsupported-locale' && on ? (
          <Banner title={`${SITE[platform]} isn't in English`}>
            unAlgorithm reads English labels, so most filters can't run on this page yet.
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
            control={<Switch checked={on} onCheckedChange={(v) => void setOn(v)} label={`unAlgorithm on ${SITE[platform]}`} />}
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
                  {noAds ? (
                    <div className="ua-footnote" style={{ marginBottom: 10 }}>
                      {POPUP_COPY.noAds}
                    </div>
                  ) : null}
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
              ) : tabState.feedLike ? (
                // The banner above says it when the card's notice is up; never "Go to feed" on the feed itself.
                notice === 'not-running' ? null : (
                  <div className="ua-secondary ua-callout" style={{ padding: '10px 0 14px' }}>
                    {POPUP_COPY.feedLike}
                  </div>
                )
              ) : (
                <div className="ua-hstack" style={{ justifyContent: 'space-between', padding: '10px 0 14px' }}>
                  <span className="ua-secondary ua-callout">unAlgorithm works on your home feed.</span>
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
