import { useState } from 'react';
import { Compass, LayoutGrid, Megaphone, RotateCcw, Share2 } from '../icons.ts';

type CardKind = 'ad' | 'suggested' | 'pymk' | 'activity' | 'plain' | 'pick';

const STORY: CardKind[] = ['plain', 'ad', 'suggested', 'pick', 'pymk', 'activity', 'plain'];

const CHIP = {
  ad: { icon: Megaphone, label: 'Ad' },
  suggested: { icon: Compass, label: 'Suggested' },
  pymk: { icon: LayoutGrid, label: 'People you may know' },
  activity: { icon: Share2, label: 'Jane liked this' },
} as const;

/**
 * Teaches the product in four seconds: noise cards fold to thin lines, the rest slide up, and one card gets the
 * "For you" ring. Plays once (WCAG 2.2.2), with Replay; static final frame under reduced motion.
 */
export function FeedCleanIllustration() {
  const [run, setRun] = useState(0);
  let noiseIndex = 0;
  return (
    <div className="ua-ill">
      <div
        className="ua-ill-feed"
        key={run}
        role="img"
        aria-label="Ads and suggested posts fold away, leaving posts from people you follow, with one highlighted for you."
      >
        {STORY.map((kind, i) => {
          const noise = kind !== 'plain' && kind !== 'pick';
          const delay = noise ? 600 + noiseIndex++ * 160 : 0;
          const chip = noise ? CHIP[kind as keyof typeof CHIP] : undefined;
          const Icon = chip?.icon;
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: the story is a fixed sequence.
              key={i}
              className={`ua-ill-card${noise ? ' ua-ill-card--noise' : ''}${kind === 'pick' ? ' ua-ill-card--pick' : ''}`}
              style={{ animationDelay: `${delay}ms` }}
            >
              <div className="ua-ill-head">
                <span className="ua-ill-avatar" />
                <span className="ua-ill-name" />
                {chip && Icon ? (
                  <span className="ua-ill-chip" style={{ animationDelay: `${delay - 300}ms` }}>
                    <Icon aria-hidden="true" />
                    {chip.label}
                  </span>
                ) : null}
                {kind === 'pick' ? <span className="ua-ill-foryou">For you</span> : null}
              </div>
              <span className="ua-ill-line" />
              <span className="ua-ill-line ua-ill-line--short" />
            </div>
          );
        })}
      </div>
      <button type="button" className="ua-button ua-button--plain ua-button--sm ua-ill-replay" onClick={() => setRun(run + 1)}>
        <RotateCcw aria-hidden="true" />
        Replay
      </button>
    </div>
  );
}

/** Five-post mini feed for the strength cards: `fold` of them fold away. */
export function PresetMiniFeed({ fold }: { fold: number }) {
  const folded = new Set([1, 3, 4].slice(0, fold));
  return (
    <div className="ua-mini" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) =>
        folded.has(i) ? <span key={i} className="ua-mini-fold" /> : <span key={i} className="ua-mini-card" />,
      )}
    </div>
  );
}

/** Thumbnail of how hidden posts look: collapsed line, removed, or dimmed. */
export function DisplayModeThumb({ mode }: { mode: 'collapse' | 'hide' | 'dim' }) {
  return (
    <div className="ua-thumb" aria-hidden="true">
      <span className="ua-mini-card" />
      {mode === 'collapse' ? <span className="ua-mini-fold" /> : null}
      {mode === 'dim' ? <span className="ua-mini-card" style={{ opacity: 0.35 }} /> : null}
      <span className="ua-mini-card" />
    </div>
  );
}
