/**
 * The account page's Credits section, on a server that advertises billing: the balance and about how many posts it
 * classifies, the promotional credit with the starter credit's state, the history newest first, and the links the server
 * gives (adding credit, how credits work). Every figure is the server's answer (`CreditAccountSchema`); the wording is
 * the extension's (`@unalgorithm/core`), so both say the same thing, and the page names no product or price of its own.
 */
import { formatBalance, formatCreditAmount, formatPostsEstimate } from '@unalgorithm/core';
import { type CreditAccount, type CreditBalance, type CreditHistoryItem, estimatePosts } from '@unalgorithm/protocol';
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

type State = { name: 'loading' } | { name: 'failed' } | { name: 'loaded'; account: CreditAccount };

export interface CreditsProps {
  /** Called when the server no longer knows the session (401): the page goes back to sign-in. Keep it stable. */
  onSignedOut(): void;
}

export function Credits({ onSignedOut }: CreditsProps) {
  const [state, setState] = useState<State>({ name: 'loading' });
  const headingId = useId();

  const load = useCallback(async () => {
    setState({ name: 'loading' });
    try {
      setState({ name: 'loaded', account: await creditAccount() });
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
      {state.name === 'loaded' ? <CreditDetails account={state.account} /> : null}
    </section>
  );
}

function CreditDetails({ account: { balance, history, addCreditPath, pricingUrl } }: { account: CreditAccount }) {
  const promotional = promotionalLine(balance);
  return (
    <>
      <div className="web-balance">
        <p className="ua-stat">{formatBalance(balance.balanceMicros)}</p>
        <p className="ua-secondary">
          {balance.balanceMicros > 0 ? formatPostsEstimate(estimatePosts(balance.balanceMicros)) : PAUSED}
        </p>
        {promotional ? <p className="ua-footnote">{promotional}</p> : null}
        {balance.starter === 'active' ? null : <p className="ua-footnote">{STARTER[balance.starter]}</p>}
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
