import { applyPreset, type Preset, presetOf, STARTER_LESS_OF, STARTER_TOPICS } from '@unalgorithm/core';
import type { PlatformId } from '@unalgorithm/protocol';
import {
  ArrowRight,
  Badge,
  Button,
  ChevronLeft,
  Chip,
  ChoiceCard,
  ChoiceCardGroup,
  CircleCheck,
  FeedCleanIllustration,
  Lockup,
  Logo,
  Pin,
  PresetMiniFeed,
  Puzzle,
  StepperDots,
} from '@unalgorithm/ui';
import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { AiSetup } from '../../components/AiSetup.tsx';
import { type BrowserKind, browserKind } from '../../lib/browser-kind.ts';
import { FEED_URLS, useDevice, useSettings } from '../../lib/hooks.ts';
import { serverLabel } from '../../lib/server-label.ts';

const STEPS = ['welcome', 'strength', 'interests', 'ai', 'done'] as const;
type Step = (typeof STEPS)[number];
const QUESTION_STEPS: Step[] = ['strength', 'interests', 'ai'];

/** How to put the toolbar button on the toolbar. Firefox starts it there (`default_area`); this is for when it moved. */
const PIN_STEPS: Record<BrowserKind, string> = {
  chrome: 'Click the puzzle piece in Chrome’s toolbar, then the pin next to unAlgorithm.',
  edge: 'Click Extensions (the puzzle piece) in Edge’s toolbar, then Show in toolbar (the eye) next to unAlgorithm.',
  firefox: 'Click Extensions (the puzzle piece) in Firefox’s toolbar, then the gear next to unAlgorithm and Pin to Toolbar.',
};

export function App() {
  const [settings, save] = useSettings();
  const [device, saveDevice] = useDevice();
  const [step, setStep] = useState<Step>('welcome');
  const [showLess, setShowLess] = useState(false);
  const [custom, setCustom] = useState('');
  const h1 = useRef<HTMLHeadingElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: persist and announce only when the step changes
  useEffect(() => {
    const titles: Record<Step, string> = {
      welcome: 'Welcome to unAlgorithm',
      strength: 'Step 1 of 3: Strength · unAlgorithm setup',
      interests: 'Step 2 of 3: Interests · unAlgorithm setup',
      ai: 'Step 3 of 3: AI · unAlgorithm setup',
      done: "You're all set · unAlgorithm",
    };
    document.title = titles[step];
    h1.current?.focus();
    if (device) void saveDevice((d) => void (d.onboarding.step = step));
  }, [step]);

  if (!settings || !device) return null;

  const idx = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, idx + 1)] as Step);
  const back = () => setStep(STEPS[Math.max(0, idx - 1)] as Step);
  const finish = async () => {
    await saveDevice((d) => void (d.onboarding.completedAt = Date.now()));
    setStep('done');
  };
  const qIndex = QUESTION_STEPS.indexOf(step);

  const platforms = (['linkedin', 'facebook'] as const).filter((p) => settings.platforms[p].enabled);
  const preset = presetOf('linkedin', settings.platforms.linkedin);
  const setPreset = (p: Preset) =>
    save((s) => {
      for (const id of ['linkedin', 'facebook'] as const) s.platforms[id] = applyPreset(id, s.platforms[id], p);
    });
  const togglePlatform = (p: PlatformId, on: boolean) => save((s) => void (s.platforms[p].enabled = on));
  const toggleTopic = (list: 'more' | 'less', t: { id: string; label: string; keywords: string[] }, on: boolean) =>
    save((s) => {
      if (on) s.interests[list][t.id] = { label: t.label, keywords: t.keywords, addedAt: Date.now() };
      else delete s.interests[list][t.id];
    });
  const selectedCount = Object.keys(settings.interests.more).length;

  return (
    <div className="onboarding">
      <header className="ob-top">
        <Lockup size={28} />
        {qIndex >= 0 ? <StepperDots count={3} current={qIndex} /> : <span />}
        {step !== 'done' && step !== 'welcome' ? (
          <Button variant="plain" onClick={step === 'ai' ? () => void finish() : next}>
            Skip
          </Button>
        ) : (
          <span />
        )}
      </header>

      <main className="ob-main" key={step}>
        {step === 'welcome' ? (
          <div className="ob-welcome">
            <div>
              <div className="ob-eyebrow">Welcome to unAlgorithm</div>
              <h1 ref={h1} tabIndex={-1}>
                See the posts you came for.
              </h1>
              <p className="ob-sub">
                unAlgorithm quietly folds away ads, suggested posts and other things you didn't ask for on LinkedIn and Facebook.
                No account needed. The rules run entirely in your browser.
              </p>
              <div className="ua-stack" style={{ justifyItems: 'start' }}>
                <Button variant="primary" size="lg" trailingIcon={ArrowRight} onClick={next}>
                  Get started
                </Button>
                <Button variant="plain" onClick={() => void finish()}>
                  Skip setup and use recommended settings
                </Button>
              </div>
            </div>
            <FeedCleanIllustration />
          </div>
        ) : null}

        {step === 'strength' ? (
          <>
            <h1 ref={h1} tabIndex={-1}>
              How calm should your feed be?
            </h1>
            <p className="ob-sub">Pick a starting point. You can change it anytime from the toolbar.</p>
            <ChoiceCardGroup<Preset>
              label="Strength"
              value={preset === 'custom' ? null : preset}
              onValueChange={(p) => void setPreset(p)}
              columns={3}
            >
              <ChoiceCard
                value="light"
                media={<PresetMiniFeed fold={1} />}
                title="Just the clutter"
                description="Hides ads and feed panels like People You May Know. Everything else stays."
              />
              <ChoiceCard
                value="balanced"
                media={<PresetMiniFeed fold={2} />}
                title="What you didn't ask for"
                badge={<Badge tone="accent">Recommended</Badge>}
                description="Also hides suggested posts, likes and comments from your network, and people you don't follow on LinkedIn."
              />
              <ChoiceCard
                value="calm"
                media={<PresetMiniFeed fold={3} />}
                title="Only what matters"
                description="Shows only people, pages and groups you follow, without Reels or reshares."
              />
            </ChoiceCardGroup>
            <div className="ua-hstack ua-wrap" style={{ marginTop: 24, gap: 10 }}>
              <span className="ua-headline">Use unAlgorithm on</span>
              {(['linkedin', 'facebook'] as const).map((p) => (
                <Chip
                  key={p}
                  label={p === 'linkedin' ? 'LinkedIn' : 'Facebook'}
                  selected={settings.platforms[p].enabled}
                  onSelectedChange={(on) => void togglePlatform(p, on)}
                />
              ))}
            </div>
          </>
        ) : null}

        {step === 'interests' ? (
          <>
            <h1 ref={h1} tabIndex={-1}>
              What do you want more of?
            </h1>
            <p className="ob-sub">Pick a few topics. Posts about them get a quiet "For you" highlight.</p>
            <div className="ua-hstack ua-wrap" style={{ gap: 8 }}>
              {STARTER_TOPICS.map((t) => (
                <Chip
                  key={t.id}
                  label={t.label}
                  selected={!!settings.interests.more[t.id]}
                  onSelectedChange={(on) => void toggleTopic('more', t, on)}
                />
              ))}
              {Object.entries(settings.interests.more)
                .filter(([id]) => !STARTER_TOPICS.some((t) => t.id === id))
                .map(([id, t]) => (
                  <Chip
                    key={id}
                    label={t.label}
                    selected
                    onSelectedChange={() => void save((s) => void delete s.interests.more[id])}
                  />
                ))}
              <input
                className="ua-input ua-pchip"
                style={{ width: 200, cursor: 'text' }}
                placeholder="Add a topic, e.g. Supply chain"
                aria-label="Add a topic"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  const label = custom.trim();
                  if (e.key === 'Enter' && label) {
                    void save(
                      (s) => void (s.interests.more[`custom-${Date.now()}`] = { label, keywords: [label], addedAt: Date.now() }),
                    );
                    setCustom('');
                  }
                }}
              />
            </div>
            <div style={{ marginTop: 24 }}>
              <Button variant="plain" onClick={() => setShowLess(!showLess)} aria-expanded={showLess}>
                Anything you'd like less of?
              </Button>
              {showLess ? (
                <div className="ua-hstack ua-wrap" style={{ gap: 8, marginTop: 10 }}>
                  {STARTER_LESS_OF.map((t) => (
                    <Chip
                      key={t.id}
                      label={t.label}
                      selected={!!settings.interests.less[t.id]}
                      onSelectedChange={(on) => void toggleTopic('less', t, on)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
            <p className="ua-footnote" style={{ marginTop: 20 }}>
              Without AI, unAlgorithm matches related words. With AI, it understands topics.
            </p>
          </>
        ) : null}

        {step === 'ai' ? (
          <>
            <h1 ref={h1} tabIndex={-1}>
              Want smarter filtering? <Badge>Optional</Badge>
            </h1>
            <p className="ob-sub">
              Rules catch labelled noise. AI can also spot off-topic posts and engagement bait, and pick the posts most worth your
              time.
            </p>
            <AiSetup device={device} />
          </>
        ) : null}

        {step === 'done' ? (
          <Done
            platforms={platforms}
            h1={h1}
            interests={selectedCount}
            aiLabel={
              !device.aiSource
                ? null
                : device.aiSource.kind === 'server'
                  ? `server:${serverLabel(device.aiSource.baseUrl).title}`
                  : device.aiSource.kind
            }
          />
        ) : null}
      </main>

      {step !== 'welcome' && step !== 'done' ? (
        <footer className="ob-bar">
          <Button variant="secondary" icon={ChevronLeft} onClick={back}>
            Back
          </Button>
          <span className="ua-hstack" style={{ gap: 12 }}>
            {step === 'interests' ? <span className="ua-footnote">{selectedCount} selected</span> : null}
            {step === 'ai' ? (
              <Button variant="plain" onClick={() => void finish()}>
                Set up later
              </Button>
            ) : null}
            <Button variant="primary" size="lg" onClick={step === 'ai' ? () => void finish() : next}>
              Continue
            </Button>
          </span>
        </footer>
      ) : (
        <footer className="ob-foot ua-footnote">
          Free and open source · by HeitechSoft ·{' '}
          <a href="https://unalgorithmfeed.com/privacy/" target="_blank" rel="noreferrer">
            Privacy
          </a>
        </footer>
      )}
    </div>
  );
}

function Done({
  platforms,
  h1,
  interests,
  aiLabel,
}: {
  platforms: PlatformId[];
  h1: React.RefObject<HTMLHeadingElement | null>;
  interests: number;
  /** The AI source kind, or `server:` and the server's title. */
  aiLabel: string | null;
}) {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const kind = browserKind();
  useEffect(() => {
    const action = browser.action as typeof browser.action & { getUserSettings?: () => Promise<{ isOnToolbar: boolean }> };
    if (!action.getUserSettings) return;
    const check = () => void action.getUserSettings?.().then((s) => setPinned(s.isOnToolbar));
    check();
    const t = window.setInterval(check, 1000);
    return () => window.clearInterval(t);
  }, []);
  const ai =
    aiLabel === null
      ? 'AI: off (rules only)'
      : aiLabel === 'on-device'
        ? 'On-device AI'
        : aiLabel === 'openai-compatible'
          ? 'Your AI server'
          : aiLabel.startsWith('server:')
            ? `AI from ${aiLabel.slice('server:'.length)}`
            : 'AI with your key';
  return (
    <div className="ob-done">
      <div className="ob-check">
        <Logo size={72} />
      </div>
      <h1 ref={h1} tabIndex={-1}>
        You're all set.
      </h1>
      <p className="ob-sub" style={{ marginBottom: 8 }}>
        Scroll your feed as usual. Hidden posts leave a thin line. Click Show anytime.
      </p>
      <div className="ua-hstack ua-wrap" style={{ justifyContent: 'center', gap: 10 }}>
        {platforms.map((p) => (
          <Button key={p} variant="primary" size="lg" href={FEED_URLS[p]}>
            Open {p === 'linkedin' ? 'LinkedIn' : 'Facebook'}
          </Button>
        ))}
      </div>
      <div className="ua-card ua-card--pad" style={{ maxWidth: 520, marginTop: 20, textAlign: 'start' }}>
        <div className="ua-hstack" style={{ gap: 12, alignItems: 'flex-start' }}>
          <span className="ua-tile ua-tile--gray" aria-hidden="true">
            {pinned ? <CircleCheck /> : <Puzzle />}
          </span>
          <div className="ua-grow">
            <div className="ua-headline">
              {pinned ? (kind === 'firefox' ? 'On your toolbar' : 'Pinned to your toolbar') : 'Pin unAlgorithm to your toolbar'}
            </div>
            <div className="ua-callout ua-secondary" style={{ marginTop: 2 }}>
              {pinned
                ? 'You’ll see how many posts are hidden on each page.'
                : `${PIN_STEPS[kind]} It shows how many posts are hidden.`}
            </div>
          </div>
          {pinned === false ? <Pin size={18} aria-hidden="true" className="ua-tertiary" /> : null}
        </div>
      </div>
      <p className="ua-footnote" style={{ marginTop: 6 }}>
        {platforms.length ? platforms.map((p) => (p === 'linkedin' ? 'LinkedIn' : 'Facebook')).join(' and ') : 'No sites'} ·{' '}
        {interests} interest
        {interests === 1 ? '' : 's'} · {ai} ·{' '}
        <a href={browser.runtime.getURL('/options.html')} target="_blank" rel="noreferrer">
          Edit
        </a>
      </p>
    </div>
  );
}
