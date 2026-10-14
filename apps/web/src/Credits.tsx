/**
 * The account page's Credits section, on a server that advertises billing: the balance and about how many posts it
 * classifies, the promotional credit with the starter credit's state, the history newest first, and the links the server
 * gives (adding credit, how credits work), and the price in effect with the next scheduled change. Every figure on the
 * account is the server's answer (`CreditAccountSchema`); the wording is the extension's (`@unalgorithm/core`), so both
 * say the same thing, and the page names no product; its price line is the published schedule of the release this
 * server runs.
 */
import { formatBalance, formatCreditAmount, formatPostsEstimate, formatPrice } from '@unalgorithm/core';
import {
  CREDIT_PRICE_SCHEDULE,
  type CreditAccount,
  type CreditBalance,
  type CreditHistoryItem,
  type CreditPriceSchedule,
  estimatePosts,
  nextPriceChange,
  retailMicrosPer1000Posts,
} from '@unalgorithm/protocol';
import { Banner, ListGroup, ListRow } from '@unalgorithm/ui';
import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError, creditAccount } from './api.ts';

const PAUSED = 'AI is paused while the balance is empty. Filters and results already saved keep working.';
const LOAD_FAILED = "Couldn't load your credits.";
const STARTER: Record<Exclude<CreditBalance['starter'], 'active'>, string> = {
  spent: 'Starter credit used.',
  expired: 'Starter credit expired.',
  unavailable: "Starter credit isn't available for this account.",
};
/** History titles; usage lines say how many posts the day's AI classified. An expiring goodwill lot is `promo-expired`. */
const HISTORY: Record<Exclude<CreditHistoryItem['reason'], 'classify'>, string> = {
  'starter-credit': 'Starter credit',
  'promo-expired': 'Promotional credit expired',
  correction: 'Correction',
  goodwill: 'Credit from support',
};
/** Dates in UTC, as the server keeps them: "Jan 11, 2027". */
const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const COUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** `at`: when the account answer arrived, the instant the price and the estimate are read at. */
type State = { name: 'loading' } | { name: 'failed' } | { name: 'loaded'; account: CreditAccount; at: Date };

export interface CreditsProps {
  /** Called when the server no longer knows the session (401): the page goes back to sign-in. Keep it stable. */
  onSignedOut(): void;
  /** The price schedule shown; the page passes none (the bundled `CREDIT_PRICE_SCHEDULE`), tests pass a stub. */
  schedule?: CreditPriceSchedule;
}

export function Credits({ onSignedOut, schedule = CREDIT_PRICE_SCHEDULE }: CreditsProps) {
  const [state, setState] = useState<State>({ name: 'loading' });
  const headingId = useId();

  const load = useCallback(async () => {
    setState({ name: 'loading' });
    try {
      const account = await creditAccount();
      setState({ name: 'loaded', account, at: new Date() });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setState({ name: 'failed' });
    }
  }, [onSignedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="web-credits" aria-labelledby={headingId} aria-busy={state.name === 'loading' || undefined}>
      <h2 id={headingId}>Credits</h2>
      {state.name === 'failed' ? (
        <Banner tone="danger" title={LOAD_FAILED} action={{ label: 'Try again', onAction: () => void load() }} />
      ) : null}
      {state.name === 'loaded' ? <CreditDetails account={state.account} at={state.at} schedule={schedule} /> : null}
    </section>
  );
}

function CreditDetails({
  account: { balance, history, addCreditPath, pricingUrl },
  at,
  schedule,
}: {
  account: CreditAccount;
  at: Date;
  schedule: CreditPriceSchedule;
}) {
  const promotional = promotionalLine(balance);
  const next = nextPriceChange(at, schedule);
  return (
    <>
      <div className="web-balance">
        <p className="ua-stat">{formatBalance(balance.balanceMicros)}</p>
        <p className="ua-secondary">
          {balance.balanceMicros > 0
            ? formatPostsEstimate(estimatePosts(balance.balanceMicros, at, 'classify', schedule))
            : PAUSED}
        </p>
        {promotional ? <p className="ua-footnote">{promotional}</p> : null}
        {balance.starter === 'active' ? null : <p className="ua-footnote">{STARTER[balance.starter]}</p>}
        <p className="ua-footnote">AI costs about {per1000Posts(at, schedule)} per 1,000 posts.</p>
        {next ? (
          // In UTC, as the change starts at 00:00 UTC: west of UTC it is the previous evening.
          <p className="ua-footnote">
            From {DATE.format(new Date(next.effectiveFrom))} (UTC): about {per1000Posts(new Date(next.effectiveFrom), schedule)}{' '}
            per 1,000 posts.
          </p>
        ) : null}
      </div>
      <ListGroup header="History">
        {history.length === 0 ? (
          <ListRow title={<span className="ua-secondary">No credit activity yet.</span>} />
        ) : (
          history.map((item, i) => (
            <ListRow
              // biome-ignore lint/suspicious/noArrayIndexKey: history lines have no id, and a loaded history never changes
              key={i}
              title={historyTitle(item)}
              subtitle={DATE.format(new Date(item.at))}
              control={<span className="web-amount">{formatCreditAmount(item.amountMicros)}</span>}
            />
          ))
        )}
      </ListGroup>
      <div className="web-credit-actions">
        {addCreditPath ? (
          // A page on this server, so it opens in place (`Button`'s links open a new tab).
          <a className="ua-button ua-button--primary" href={addCreditPath}>
            Add credit
          </a>
        ) : (
          <p className="ua-footnote">Adding credit isn't available yet.</p>
        )}
        {pricingUrl ? (
          <a href={pricingUrl} target="_blank" rel="noreferrer">
            How credits work
          </a>
        ) : null}
      </div>
    </>
  );
}

/** The published price of 1,000 classified posts at `at`, "about" because it is the reference model's, warm cache. */
function per1000Posts(at: Date, schedule: CreditPriceSchedule): string {
  return formatPrice(retailMicrosPer1000Posts(at, 'classify', schedule));
}

/**
 * The promotional credit held: the starter credit and any other promotional lot (goodwill), so never "Starter credit:".
 * Shown while the starter credit is active, and whenever promotional credit is held after it.
 */
function promotionalLine({ starter, promoMicros, promoExpiresAt }: CreditBalance): string | null {
  if (starter !== 'active' && promoMicros <= 0) return null;
  const left = `Promotional credit: ${formatBalance(promoMicros)} left`;
  // No expiry is no date at all: `new Date(null)` would read "Jan 1, 1970".
  return promoExpiresAt === null ? left : `${left}, first expiry ${DATE.format(new Date(promoExpiresAt))}`;
}

function historyTitle(item: CreditHistoryItem): string {
  if (item.reason !== 'classify') return HISTORY[item.reason];
  const posts = item.posts ?? 0;
  return `AI for ${COUNT.format(posts)} ${posts === 1 ? 'post' : 'posts'}`;
}
