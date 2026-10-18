import type { FactcheckClaim, FactcheckResult, FactcheckSource, FactcheckVerdict } from '@unalgorithm/protocol';
import { Fragment } from 'react';
import { ChevronLeft, ExternalLink, LoaderCircle, SearchCheck } from '../icons.ts';
import { IconButton } from './controls.tsx';
import { Badge, Banner, EmptyState } from './feedback.tsx';

/** Each verdict in words (never colour alone), with the badge tone that goes with it. */
export const VERDICT_LABELS: Record<
  FactcheckVerdict,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'accent' }
> = {
  supported: { label: 'Supported', tone: 'success' },
  disputed: { label: 'Disputed', tone: 'danger' },
  misleading: { label: 'Misleading', tone: 'warning' },
  unverifiable: { label: "Can't verify", tone: 'neutral' },
  'needs-context': { label: 'Needs context', tone: 'accent' },
};

export interface FactcheckSheetProps {
  /** The post label (`FactcheckEntry.label`). */
  label: string;
  status: 'running' | 'done' | 'failed';
  result?: FactcheckResult;
  errorMessage?: string;
  /** Up to 4 older checks on this tab. */
  earlier?: { label: string; onOpen(): void }[];
  /** What the check cost or was charged (`checkCostLine`), shown in the footer when set. */
  costLine?: string | null | undefined;
  /** Links shown last in the footer of a finished check (how it works, report a mistake): the extension's own URLs. */
  links?: readonly SheetFootLink[] | undefined;
  onBack(): void;
}

/** A link in a sheet's footer. Its `href` is one of the extension's own `https:` URLs, never one from a result. */
export interface SheetFootLink {
  text: string;
  href: string;
}

const CHECKED_AT_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
/** The date only: a cached time is kept only to the hour, and a clock time would say when someone else checked. */
const CACHED_AT_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: 'medium' };

/**
 * One fact-check in the side panel: each claim with its verdict, explanation and quoted sources. Model and page text
 * render only as React text nodes; source URLs are http(s) by `FactcheckSourceSchema`.
 */
export function FactcheckSheet({
  label,
  status,
  result,
  errorMessage,
  earlier = [],
  costLine,
  links,
  onBack,
}: FactcheckSheetProps) {
  return (
    <section className="ua-factcheck" aria-label="Fact-check">
      <div className="ua-factcheck-head">
        <IconButton icon={ChevronLeft} label="Back" onClick={onBack} />
        <h2 className="ua-factcheck-title">Fact-check</h2>
        <Badge tone="ai">AI-generated</Badge>
      </div>
      <div className="ua-factcheck-post">{label}</div>

      {status === 'running' ? (
        <div className="ua-factcheck-running" aria-live="polite">
          <LoaderCircle className="ua-spin" aria-hidden="true" />
          <span>Checking facts… This can take up to a minute.</span>
        </div>
      ) : status === 'failed' ? (
        <Banner tone="warning" title="The fact-check didn't finish">
          {errorMessage}
        </Banner>
      ) : result && result.claims.length === 0 ? (
        <EmptyState
          icon={SearchCheck}
          title="No checkable claims found"
          body="This post doesn't make a factual claim we can check."
        />
      ) : result ? (
        <ol className="ua-factcheck-claims">
          {result.claims.map((c) => (
            <ClaimItem key={c.id} claim={c} sources={result.sources} />
          ))}
        </ol>
      ) : null}

      {status === 'done' && result ? (
        <footer className="ua-factcheck-foot">
          <div>Checked {new Date(result.checkedAt).toLocaleString(undefined, CHECKED_AT_FORMAT)}</div>
          <div>AI can be wrong, so open the sources.</div>
          {costLine ? <div>{costLine}</div> : null}
          <FootLinks links={links} />
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

function ClaimItem({ claim, sources }: { claim: FactcheckClaim; sources: FactcheckSource[] }) {
  const verdict = VERDICT_LABELS[claim.verdict];
  return (
    <li className="ua-factcheck-claim">
      <div className="ua-factcheck-claim-text">{claim.claim}</div>
      <div>
        <Badge tone={verdict.tone}>{verdict.label}</Badge>
      </div>
      {claim.cachedAt ? (
        <p className="ua-factcheck-note">
          From an earlier check on {new Date(claim.cachedAt).toLocaleDateString(undefined, CACHED_AT_FORMAT)}.
        </p>
      ) : null}
      {claim.explanation ? <p className="ua-factcheck-explanation">{claim.explanation}</p> : null}
      {claim.downgraded === 'too-few-domains' ? <p className="ua-factcheck-note">Fewer than two independent sources.</p> : null}
      {claim.citations.map((cite, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: citations have no id of their own and never reorder
        <CitationFigure key={i} quote={cite.quote} source={sources.find((s) => s.id === cite.sourceId)} />
      ))}
    </li>
  );
}

/** A sheet footer's links in one line, separated by " · ", each opening in a new tab; nothing when there are none. */
export function FootLinks({ links = [] }: { links?: readonly SheetFootLink[] | undefined }) {
  if (!links.length) return null;
  return (
    <div>
      {links.map((l, i) => (
        <Fragment key={l.href}>
          {i ? ' · ' : null}
          <a href={l.href} target="_blank" rel="noopener noreferrer">
            {l.text}
          </a>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * One quoted source: the quote, then a link to the page (title, then the outlet name when the source has one, else its
 * domain). Shared by the fact-check and perspectives sheets; text renders only as React text nodes.
 */
export function CitationFigure({ quote, source }: { quote: string; source?: FactcheckSource & { outlet?: string } }) {
  return (
    <figure className="ua-factcheck-cite">
      {quote ? <blockquote>{quote}</blockquote> : null}
      {source ? (
        <figcaption>
          <a href={source.url} target="_blank" rel="noopener noreferrer">
            <span className="ua-factcheck-source-title">{source.title}</span>
            <span className="ua-factcheck-source-domain">{source.outlet ?? source.domain}</span>
            <ExternalLink aria-hidden="true" />
          </a>
        </figcaption>
      ) : null}
    </figure>
  );
}
