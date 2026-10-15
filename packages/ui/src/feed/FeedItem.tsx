import type { FilterReason } from '@unalgorithm/core';
import type { PlatformId } from '@unalgorithm/protocol';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../components/controls.tsx';
import { Badge } from '../components/feedback.tsx';
import {
  CircleSlash2,
  Clapperboard,
  Compass,
  Eye,
  EyeOff,
  Fish,
  Flame,
  FoldVertical,
  LayoutGrid,
  LoaderCircle,
  type LucideIcon,
  Megaphone,
  Repeat2,
  SearchCheck,
  Settings,
  Share2,
  Sparkle,
  ToggleLeft,
  UserCheck,
  UserRoundX,
  UsersRound,
  VolumeX,
} from '../icons.ts';
import type { WhyActionId, WhyModel } from './why.ts';

export type FeedItemState = 'collapsed' | 'dimmed' | 'revealed' | 'shown';

/** "Check facts" on a flagged public post (Labs): offered, then the price, then running, then the outcome. */
export interface FactcheckItemModel {
  state: 'offered' | 'confirming' | 'running' | 'done' | 'failed';
  /** factcheckPriceLabel(...), e.g. 'About $0.12 on your Anthropic account'. */
  price: string;
  /** failed: the error; done: the toolbar hint when the panel could not open. */
  message?: string;
}

export type FactcheckAction = 'start' | 'confirm' | 'cancel' | 'open' | 'retry';

export interface FeedItemModel {
  key: string;
  platform: PlatformId;
  state: FeedItemState;
  reason?: FilterReason;
  reasonLabel?: string;
  /** The decision was made by AI (labelled with a sparkle). */
  ai?: boolean;
  /** Author, advertiser or panel title. */
  who?: string;
  showReason: boolean;
  /** Set on the first stub of several hidden posts in a row. */
  run?: { count: number; labels: string[] };
  why?: WhyModel;
  highlight?: { matched: string[] };
  forYouStyle: 'ring' | 'label' | 'off';
  vote?: 'more' | 'less';
  coach?: boolean;
  factcheck?: FactcheckItemModel;
}

export interface FeedItemHandlers {
  onShow(): void;
  onHide(): void;
  onShowAll(): void;
  onWhyAction(id: WhyActionId): void;
  onVote(v: 'more' | 'less' | null): void;
  onCoachDone(): void;
  onFactcheck(action: FactcheckAction): void;
}

const REASON_GLYPH: Partial<Record<FilterReason, LucideIcon>> = {
  sponsored: Megaphone,
  suggested: Compass,
  'network-activity': Share2,
  reshare: Repeat2,
  'unjoined-group': UsersRound,
  reel: Clapperboard,
  'not-followed': UserRoundX,
  module: LayoutGrid,
  'always-hide': EyeOff,
  'muted-keyword': VolumeX,
  'less-like-this': CircleSlash2,
  'low-relevance': CircleSlash2,
};

function glyphFor(model: Pick<FeedItemModel, 'reason' | 'reasonLabel'>): LucideIcon {
  if (model.reason === 'noise') return /rage/i.test(model.reasonLabel ?? '') ? Flame : Fish;
  return (model.reason && REASON_GLYPH[model.reason]) || FoldVertical;
}

function Chip({ model }: { model: FeedItemModel }) {
  const Glyph = glyphFor(model);
  return (
    <span className={model.ai ? 'ua-chip ua-chip--ai' : 'ua-chip'}>
      <Glyph aria-hidden="true" />
      {model.reasonLabel}
      {model.ai ? <Sparkle aria-hidden="true" /> : null}
    </span>
  );
}

const ACTION_ICON: Record<WhyActionId, LucideIcon> = {
  show: Eye,
  'always-show-author': UserCheck,
  'stop-hiding': ToggleLeft,
  'unmute-topic': VolumeX,
  'not-bait': UserCheck,
  'want-like-this': UserCheck,
  settings: Settings,
  report: Settings,
};

function WhyButton({ model, onAction }: { model: FeedItemModel; onAction: (id: WhyActionId) => void }) {
  const id = useId().replace(/:/g, '');
  const popRef = useRef<HTMLDivElement>(null);
  const why = model.why;
  useEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState === 'open') pop.querySelector<HTMLElement>('button')?.focus();
    };
    pop.addEventListener('toggle', onToggle);
    return () => pop.removeEventListener('toggle', onToggle);
  }, []);
  if (!why) return null;
  const anchor = `--ua-why-${id}`;
  return (
    <>
      <button
        type="button"
        className="ua-btn"
        popoverTarget={`ua-why-${id}`}
        aria-haspopup="dialog"
        aria-label={`Why was this hidden? ${model.reasonLabel ?? ''}`}
        style={{ anchorName: anchor } as React.CSSProperties}
      >
        Why?
      </button>
      <div
        ref={popRef}
        id={`ua-why-${id}`}
        popover="auto"
        role="dialog"
        aria-labelledby={`ua-why-title-${id}`}
        className="ua-popover"
        style={{ positionAnchor: anchor } as React.CSSProperties}
      >
        <div className="ua-pop-head" id={`ua-why-title-${id}`}>
          {(() => {
            const G = glyphFor(model);
            return <G aria-hidden="true" />;
          })()}
          {why.title}
        </div>
        <p className="ua-pop-body">{why.body}</p>
        {why.saw ? <p className="ua-pop-note">What we saw: {why.saw}</p> : null}
        <div className="ua-pop-sep" />
        {why.actions.map((a) => {
          const Icon = ACTION_ICON[a.id];
          return (
            <button
              key={a.id}
              type="button"
              className="ua-action"
              onClick={() => {
                popRef.current?.hidePopover();
                onAction(a.id);
              }}
            >
              <Icon aria-hidden="true" />
              {a.label}
            </button>
          );
        })}
        <div className="ua-pop-sep" />
        <div className="ua-pop-foot">
          <span>{why.footnote}</span>
          <span>
            <button
              type="button"
              className="ua-link"
              onClick={() => {
                popRef.current?.hidePopover();
                onAction('settings');
              }}
            >
              Filter settings
            </button>
            {' · '}
            <button
              type="button"
              className="ua-link"
              onClick={() => {
                popRef.current?.hidePopover();
                onAction('report');
              }}
            >
              Wrong call?
            </button>
          </span>
        </div>
      </div>
    </>
  );
}

function CoachMark({ anchor, onDone }: { anchor: string; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pop = ref.current;
    if (!pop) return;
    try {
      pop.showPopover();
    } catch {
      return;
    }
    // Counts as seen once it has been visible for two seconds.
    const t = window.setTimeout(onDone, 2000);
    return () => window.clearTimeout(t);
  }, [onDone]);
  return (
    <div
      ref={ref}
      popover="manual"
      role="dialog"
      aria-label="Tip"
      className="ua-popover ua-coach"
      style={{ positionAnchor: anchor } as React.CSSProperties}
    >
      <div className="ua-pop-head">We folded away a post you didn't ask for</div>
      <p className="ua-pop-body">Click Show to see it, or Why? to change the rule. Nothing is deleted.</p>
      <div className="ua-coach-actions">
        <span />
        <button type="button" className="ua-primary" onClick={() => ref.current?.hidePopover()}>
          Got it
        </button>
      </div>
    </div>
  );
}

function Row({ children, bar, label }: { children: ReactNode; bar?: boolean; label: string }) {
  return (
    <div className={bar ? 'ua-row ua-row--bar' : 'ua-row ua-stub'} role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** The quiet fact-check row. A check never starts without the price shown and a second click on "Check". */
function FactcheckRow({ model, on }: { model: FactcheckItemModel; on: (action: FactcheckAction) => void }) {
  const checkRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (model.state === 'confirming') checkRef.current?.focus();
  }, [model.state]);
  const text =
    model.state === 'confirming'
      ? model.price
      : model.state === 'running'
        ? 'Checking facts…'
        : model.state === 'done'
          ? ['Checked.', model.message].filter(Boolean).join(' ')
          : model.state === 'failed'
            ? model.message
            : '';
  return (
    <div className="ua-row ua-row--bar ua-fc" role="group" aria-label="Fact-check">
      {model.state === 'offered' ? (
        <>
          <Button size="sm" variant="tinted" className="ua-btn ua-btn--tint" icon={SearchCheck} onClick={() => on('start')}>
            Check facts
          </Button>
          <Badge tone="ai">Labs</Badge>
        </>
      ) : null}
      <span className="ua-fc-status" aria-live="polite">
        {model.state === 'running' ? <LoaderCircle className="ua-glyph ua-spin" aria-hidden="true" /> : null}
        {text}
      </span>
      {model.state === 'confirming' ? (
        <>
          <Button ref={checkRef} size="sm" variant="tinted" className="ua-btn ua-btn--tint" onClick={() => on('confirm')}>
            Check
          </Button>
          <Button size="sm" variant="plain" className="ua-btn" onClick={() => on('cancel')}>
            Cancel
          </Button>
        </>
      ) : null}
      {model.state === 'done' ? (
        <Button size="sm" variant="plain" className="ua-btn ua-btn--accent" onClick={() => on('open')}>
          See result
        </Button>
      ) : null}
      {model.state === 'failed' ? (
        <Button size="sm" variant="plain" className="ua-btn ua-btn--accent" onClick={() => on('retry')}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** The UI UnAlgorithm adds to one feed item. Ordinary posts never render this at all. */
export function FeedItem({ model, on }: { model: FeedItemModel; on: FeedItemHandlers }) {
  // The fact-check row sits below whatever else the item shows; a plain shown post gets only the row.
  return (
    <>
      <ItemMain model={model} on={on} />
      {model.factcheck ? <FactcheckRow model={model.factcheck} on={on.onFactcheck} /> : null}
    </>
  );
}

function ItemMain({ model, on }: { model: FeedItemModel; on: FeedItemHandlers }) {
  const [confirm, setConfirm] = useState<'more' | 'less' | null>(null);
  const anchorId = useId().replace(/:/g, '');
  const anchor = `--ua-stub-${anchorId}`;
  useEffect(() => {
    if (!confirm) return;
    const t = window.setTimeout(() => setConfirm(null), 3000);
    return () => window.clearTimeout(t);
  }, [confirm]);

  if (model.state === 'collapsed') {
    const run = model.run && model.run.count > 1 ? model.run : undefined;
    return (
      <div style={{ anchorName: anchor } as React.CSSProperties}>
        <h2 className="ua-vh">Hidden post</h2>
        <Row label={run ? `${run.count} hidden posts` : `Hidden post: ${model.reasonLabel ?? ''}`}>
          <FoldVertical className="ua-glyph" aria-hidden="true" />
          <span className="ua-label">{run ? `${run.count} hidden` : 'Hidden'}</span>
          {model.showReason ? <Chip model={model} /> : null}
          {run
            ? run.labels
                .filter((l) => l !== model.reasonLabel)
                .slice(0, 2)
                .map((l) => (
                  <span key={l} className="ua-chip">
                    {l}
                  </span>
                ))
            : null}
          <span className="ua-who">{run ? '' : model.who}</span>
          {run ? null : <WhyButton model={model} onAction={on.onWhyAction} />}
          <button
            type="button"
            className="ua-btn ua-btn--accent"
            onClick={run ? on.onShowAll : on.onShow}
            aria-label={
              run
                ? `Show all ${run.count} hidden posts`
                : `Show ${model.reasonLabel ?? 'hidden'} post${model.who ? ` from ${model.who}` : ''}`
            }
          >
            {run ? 'Show all' : 'Show'}
          </button>
        </Row>
        {model.coach ? <CoachMark anchor={anchor} onDone={on.onCoachDone} /> : null}
      </div>
    );
  }

  if (model.state === 'dimmed') {
    return (
      <Row bar label={`Dimmed post: ${model.reasonLabel ?? ''}`}>
        <FoldVertical className="ua-glyph" aria-hidden="true" />
        <span className="ua-label">Dimmed</span>
        {model.showReason ? <Chip model={model} /> : null}
        <span className="ua-spacer" />
        <WhyButton model={model} onAction={on.onWhyAction} />
      </Row>
    );
  }

  if (model.state === 'revealed') {
    return (
      <Row bar label="Shown post">
        <Eye className="ua-glyph" aria-hidden="true" />
        <span className="ua-label">Shown</span>
        {model.showReason ? <Chip model={model} /> : null}
        <span className="ua-spacer" />
        <WhyButton model={model} onAction={on.onWhyAction} />
        <button type="button" className="ua-btn" onClick={on.onHide}>
          Hide again
        </button>
      </Row>
    );
  }

  if (!model.highlight || model.forYouStyle === 'off') return null;
  const matched = model.highlight.matched.slice(0, 2);
  return (
    <Row bar label="Picked for you">
      <span className="ua-foryou-dot" aria-hidden="true" />
      <span className="ua-foryou">For you</span>
      <span className="ua-who">{matched.length ? `Matches ${matched.join(', ')}` : ''}</span>
      {confirm ? (
        <span className="ua-confirm" role="status">
          {confirm === 'more' ? 'Got it. More posts like this.' : 'Got it. Fewer posts like this.'}{' '}
          <button
            type="button"
            className="ua-btn ua-btn--accent"
            onClick={() => {
              setConfirm(null);
              on.onVote(null);
            }}
          >
            Undo
          </button>
        </span>
      ) : (
        <>
          <button
            type="button"
            className="ua-btn"
            aria-pressed={model.vote === 'more'}
            onClick={() => {
              setConfirm('more');
              on.onVote('more');
            }}
          >
            More like this
          </button>
          <button
            type="button"
            className="ua-btn"
            onClick={() => {
              setConfirm('less');
              on.onVote('less');
            }}
          >
            Not for me
          </button>
        </>
      )}
    </Row>
  );
}
