import {
  BUCKET_LABELS,
  type DIFFERENCE_KINDS,
  FEATURE_NAMES,
  type PerspectivesResult,
  type PerspectivesSource,
} from '@unalgorithm/protocol';
import type { ReactNode } from 'react';
import { ChevronLeft, ExternalLink, LoaderCircle, Newspaper } from '../icons.ts';
import { IconButton } from './controls.tsx';
import { CitationFigure } from './factcheck.tsx';
import { Badge, Banner, EmptyState } from './feedback.tsx';

/** Each lean bucket in words (never colour alone), from the protocol: one map for the sheet and every list page. */
export { BUCKET_LABELS };

export const DIFFERENCE_LABELS: Record<(typeof DIFFERENCE_KINDS)[number], string> = {
  emphasis: 'Emphasis',
  framing: 'Framing',
  sourcing: 'Sourcing',
  omission: 'Omission',
};

export interface PerspectivesSheetProps {
  /** The link title or host (`FactcheckEntry.label`), never post text. */
  label: string;
  status: 'running' | 'done' | 'failed';
  result?: PerspectivesResult;
  errorMessage?: string;
  /** Up to 4 older checks and comparisons on this tab. */
  earlier?: { label: string; onOpen(): void }[];
  onBack(): void;
}

type Point = PerspectivesResult['agreed'][number];

const COMPARED_AT_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
const DAY_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: 'medium' };
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, DAY_FORMAT);
/** A search result's page age as a date when it parses as one, else as given. */
const pageDay = (age: string) => (Number.isNaN(Date.parse(age)) ? age : day(age));

/**
 * One UnEcho Chamber comparison in the side panel: who covered the story by lean bucket (every gap named),
 * facts agreed across sides, differences and one-side claims, each with quoted sources. Model and page text render
 * only as React text nodes; source URLs are http(s) by `PerspectivesSourceSchema`.
 */
export function PerspectivesSheet({ label, status, result, errorMessage, earlier = [], onBack }: PerspectivesSheetProps) {
  return (
    <section className="ua-factcheck ua-perspectives" aria-label={FEATURE_NAMES.perspectives}>
      <div className="ua-factcheck-head">
        <IconButton icon={ChevronLeft} label="Back" onClick={onBack} />
        <h2 className="ua-factcheck-title">{FEATURE_NAMES.perspectives}</h2>
        <Badge tone="ai">AI-generated</Badge>
      </div>
      <div className="ua-factcheck-post">{label}</div>

      {status === 'running' ? (
        <div className="ua-factcheck-running" aria-live="polite">
          <LoaderCircle className="ua-spin" aria-hidden="true" />
          <span>Comparing coverage… This can take up to a minute.</span>
        </div>
      ) : status === 'failed' ? (
        <Banner tone="warning" title="The comparison didn't finish">
          {errorMessage}
        </Banner>
      ) : result ? (
        <Comparison result={result} />
      ) : null}

      {status === 'done' && result ? (
        <footer className="ua-factcheck-foot">
          <div>Compared {new Date(result.checkedAt).toLocaleString(undefined, COMPARED_AT_FORMAT)}</div>
          <div>
            Leans come from the UnAlgorithm outlet registry ({result.registryVersion}), reviewed by people, never from AI.
          </div>
          <div>AI can be wrong, so open the sources.</div>
        </footer>
      ) : null}

      {earlier.length ? (
        <div className="ua-factcheck-earlier">
          <div className="ua-factcheck-earlier-title">Earlier checks</div>
          {earlier.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: labels can repeat and the list is display-only
            <button key={i} type="button" className="ua-factcheck-earlier-item" onClick={e.onOpen}>
              {e.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Comparison({ result }: { result: PerspectivesResult }) {
  const byId = new Map(result.sources.map((s) => [s.id, s]));
  const gaps = result.coverage.filter((c) => c.sourceIds.length === 0).map((c) => BUCKET_LABELS[c.bucket]);
  const story = (
    <div className="ua-perspectives-story">
      <div className="ua-factcheck-claim-text">{result.story.query}</div>
      <div className="ua-perspectives-window">
        Coverage from {day(result.story.from)} to {day(result.story.to)}
      </div>
    </div>
  );

  if (gaps.length === result.coverage.length) {
    return (
      <>
        {story}
        <EmptyState
          icon={Newspaper}
          title="No coverage found"
          body="None of the outlets in our list covered this story in these dates."
        />
      </>
    );
  }

  const cite = (p: Point) =>
    p.citations.map((c, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: citations have no id of their own and never reorder
      <CitationFigure key={i} quote={c.quote} source={byId.get(c.sourceId)} />
    ));
  const sidesOf = (p: Point) => [
    ...new Set(p.citations.flatMap((c) => byId.get(c.sourceId)?.bucket ?? []).map((b) => BUCKET_LABELS[b])),
  ];

  return (
    <>
      {story}
      <PerspectivesSection title="Coverage">
        <ul className="ua-perspectives-coverage" aria-label="Coverage by lean">
          {result.coverage.map((c) => (
            <li key={c.bucket} className="ua-perspectives-bucket">
              <div className="ua-perspectives-bucket-label">{BUCKET_LABELS[c.bucket]}</div>
              {c.sourceIds.length ? (
                <ul className="ua-perspectives-sources">
                  {c.sourceIds.flatMap((id) => {
                    const s = byId.get(id);
                    return s ? [<CoverageSource key={id} source={s} />] : [];
                  })}
                </ul>
              ) : (
                <div className="ua-perspectives-gap">No coverage found</div>
              )}
            </li>
          ))}
        </ul>
        {gaps.length ? <p className="ua-factcheck-note">No coverage found from: {gaps.join(', ')}.</p> : null}
      </PerspectivesSection>

      {result.agreed.length ? (
        <PerspectivesSection title="Agreed across sides">
          <ol className="ua-factcheck-claims">
            {result.agreed.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: points have no id of their own and never reorder
              <PointItem key={i} text={p.text}>
                {cite(p)}
              </PointItem>
            ))}
          </ol>
        </PerspectivesSection>
      ) : null}

      {result.differences.length ? (
        <PerspectivesSection title="Differences">
          <ol className="ua-factcheck-claims">
            {result.differences.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: points have no id of their own and never reorder
              <PointItem key={i} text={p.text} badges={[DIFFERENCE_LABELS[p.kind]]}>
                {cite(p)}
              </PointItem>
            ))}
          </ol>
        </PerspectivesSection>
      ) : null}

      {result.unique.length ? (
        <PerspectivesSection title="Only one side reported">
          <ol className="ua-factcheck-claims">
            {result.unique.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: points have no id of their own and never reorder
              <PointItem key={i} text={p.text} badges={sidesOf(p)}>
                {cite(p)}
              </PointItem>
            ))}
          </ol>
        </PerspectivesSection>
      ) : null}
    </>
  );
}

function PerspectivesSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ua-perspectives-section" aria-label={title}>
      <h3 className="ua-perspectives-section-title">{title}</h3>
      {children}
    </section>
  );
}

function PointItem({ text, badges = [], children }: { text: string; badges?: string[]; children: ReactNode }) {
  return (
    <li className="ua-factcheck-claim">
      {badges.length ? (
        <div className="ua-perspectives-badges">
          {badges.map((b) => (
            <Badge key={b}>{b}</Badge>
          ))}
        </div>
      ) : null}
      <div className="ua-factcheck-claim-text">{text}</div>
      {children}
    </li>
  );
}

function CoverageSource({ source }: { source: PerspectivesSource }) {
  return (
    <li className="ua-perspectives-source">
      <span className="ua-perspectives-outlet">{source.outlet}</span>
      <a href={source.url} target="_blank" rel="noopener noreferrer">
        <span className="ua-factcheck-source-title">{source.title}</span>
        <ExternalLink aria-hidden="true" />
      </a>
      {source.pageAge ? <span className="ua-factcheck-source-domain">{pageDay(source.pageAge)}</span> : null}
    </li>
  );
}
