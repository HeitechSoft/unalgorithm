/**
 * The account page's Credits section, on a server that advertises billing: the balance and about how many posts it
 * classifies, the promotional credit with the starter credit's state, the purchased credit, the history newest first,
 * the links the server gives (adding credit, auto-reload, how credits work, the refund policy), and the price in effect with
 * every later scheduled change. Every figure on the account is the server's answer (`CreditAccountSchema`); the wording is the
 * extension's (`@unalgorithm/core`), so both say the same thing, and the page names no product; its price lines and the
 * amount range are this server's published prices (`/prices.json`, PA-04), read with the account.
 */
import { formatBalance, formatCreditAmount, formatPostsEstimate, formatPrice } from '@unalgorithm/core';
import {
  type AutoReloadSummary,
  type CreditAccount,
  type CreditBalance,
  type CreditHistoryItem,
  type CreditPriceSchedule,
  type CreditTask,
  estimatePosts,
  FEATURE_NAMES,
  type PriceBook,
  type PurchaseRules,
  retailMicrosPer1000Posts,
} from '@unalgorithm/protocol';
import { Banner, ListGroup, ListRow } from '@unalgorithm/ui';
import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError, creditAccount, publicPrices } from './api.ts';

const PAUSED = 'AI is paused while the balance is empty. Filters and results already saved keep working.';
const LOAD_FAILED = "Couldn't load your credits.";
const STARTER: Record<Exclude<CreditBalance['starter'], 'active'>, string> = {
  spent: 'Starter credit used.',
  expired: 'Starter credit expired.',
  unavailable: "Starter credit isn't available for this account.",
};
/** History titles other than usage lines (`usageTitle`). An expiring goodwill lot is `promo-expired`. */
const HISTORY: Record<Exclude<CreditHistoryItem['reason'], CreditTask>, string> = {
  'starter-credit': 'Starter credit',
  'promo-expired': 'Promotional credit expired',
  correction: 'Correction',
  goodwill: 'Credit from support',
  // The reason keeps the name it had when credit came in packs; any amount within the rules is a purchase now.
  'credit-pack': 'Credit purchase',
  refund: 'Refund',
  chargeback: 'Chargeback',
  'chargeback-reversed': 'Chargeback reversed',
  'test-mode-void': 'Test credit removed',
  'auto-reload': 'Auto-reload',
};
/** Dates in UTC, as the server keeps them: "Jan 11, 2027". */
const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const COUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
/** Whole dollars, as the amount rules have them: "$5", "$500". */
const wholeDollars = (micros: number): string => `$${COUNT.format(micros / 1_000_000)}`;
/**
 * "Any amount from $5 to $500.": the rules a purchase on the server's page follows (`creditAmount`), from its published
 * prices. Draft copy (D21).
 */
const amountRange = ({ minMicros, maxMicros }: PurchaseRules) =>
  `Any amount from ${wholeDollars(minMicros)} to ${wholeDollars(maxMicros)}.`;

/** `at`: when both answers had arrived, the instant the price and the estimate are read at. */
type State = { name: 'loading' } | { name: 'failed' } | { name: 'loaded'; account: CreditAccount; prices: PriceBook; at: Date };

export interface CreditsProps {
  /** Called when the server no longer knows the session (401): the page goes back to sign-in. Keep it stable. */
  onSignedOut(): void;
}

export function Credits({ onSignedOut }: CreditsProps) {
  const [state, setState] = useState<State>({ name: 'loading' });
  const headingId = useId();

  const load = useCallback(async () => {
    setState({ name: 'loading' });
    // Both at once; a 401 from the account goes back to sign-in whatever the prices answered.
    const [account, prices] = await Promise.allSettled([creditAccount(), publicPrices()]);
    if (account.status === 'rejected' && account.reason instanceof ApiError && account.reason.status === 401) {
      onSignedOut();
    } else if (account.status === 'fulfilled' && prices.status === 'fulfilled') {
      setState({ name: 'loaded', account: account.value, prices: prices.value, at: new Date() });
    } else {
      setState({ name: 'failed' });
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
      {state.name === 'loaded' ? <CreditDetails account={state.account} at={state.at} prices={state.prices} /> : null}
    </section>
  );
}

/**
 * Every later entry whose classify price per 1,000 posts differs from the price before it, in date order. Skips entries
 * that change only other tasks (a new perspectives card), and never stops at the first change: a cut saved after a
 * raise but dated before it must not hide the raise's notice.
 */
function laterClassifyPriceChanges(at: Date, schedule: CreditPriceSchedule): Date[] {
  const changes: Date[] = [];
  let before = retailMicrosPer1000Posts(at, 'classify', schedule);
  for (const { effectiveFrom } of schedule) {
    const from = new Date(effectiveFrom);
    if (!(from.getTime() > at.getTime())) continue;
    const price = retailMicrosPer1000Posts(from, 'classify', schedule);
    if (price !== before) changes.push(from);
    before = price;
  }
  return changes;
}

function CreditDetails({
  account: { balance, history, addCreditPath, autoReload, pricingUrl, refundPolicyUrl },
  at,
  prices: { schedule, purchase },
}: {
  account: CreditAccount;
  at: Date;
  prices: PriceBook;
}) {
  const promotional = promotionalLine(balance);
  const later = laterClassifyPriceChanges(at, schedule);
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
        {balance.purchasedMicros > 0 ? (
          // No expiry: the protocol has none for purchased credit.
          <p className="ua-footnote">Purchased credit: {formatBalance(balance.purchasedMicros)}</p>
        ) : null}
        {balance.starter === 'active' ? null : <p className="ua-footnote">{STARTER[balance.starter]}</p>}
        <p className="ua-footnote">AI costs about {per1000Posts(at, schedule)} per 1,000 posts.</p>
        {later.map((from) => (
          // In UTC, as a change starts at 00:00 UTC: west of UTC it is the previous evening.
          <p className="ua-footnote" key={from.toISOString()}>
            From {DATE.format(from)} (UTC): about {per1000Posts(from, schedule)} per 1,000 posts.
          </p>
        ))}
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
          <>
            {/* A page on this server, so it opens in place (`Button`'s links open a new tab). */}
            <a className="ua-button ua-button--primary" href={addCreditPath}>
              Add credit
            </a>
            <p className="ua-footnote">{amountRange(purchase)}</p>
          </>
        ) : (
          <p className="ua-footnote">Adding credit isn't available yet.</p>
        )}
        {autoReload ? <AutoReloadLine summary={autoReload} /> : null}
        {pricingUrl ? (
          <a href={pricingUrl} target="_blank" rel="noreferrer">
            How credits work
          </a>
        ) : null}
        {refundPolicyUrl ? (
          <a href={refundPolicyUrl} target="_blank" rel="noreferrer">
            Refund policy
          </a>
        ) : null}
      </div>
    </>
  );
}

/**
 * Whether credit is bought automatically, with a link to the server's auto-reload page (it opens in place, like "Add
 * credit"). Draft copy (D21).
 */
function AutoReloadLine({ summary }: { summary: AutoReloadSummary }) {
  const { path, state, amountMicros = 0, thresholdMicros = 0, monthlyLimitMicros = 0 } = summary;
  const [sentence, label] =
    state === 'on'
      ? [
          `Auto-reload: ${formatBalance(amountMicros)} when the balance is under ${formatBalance(thresholdMicros)}, up to ${formatBalance(monthlyLimitMicros)} a month.`,
          'Change auto-reload',
        ]
      : state === 'stopped'
        ? ["Auto-reload is off: the last automatic payment didn't go through.", 'Set up auto-reload again']
        : ['Auto-reload is off.', 'Set up auto-reload'];
  return (
    <>
      <p className="ua-footnote">{sentence}</p>
      <a href={path}>{label}</a>
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

/** Usage lines say how many units the day used: posts classified, checks or comparisons. Draft copy (D21). */
const USAGE: Record<CreditTask, (n: string, one: boolean) => string> = {
  classify: (n, one) => `AI for ${n} ${one ? 'post' : 'posts'}`,
  factcheck: (n, one) => `${FEATURE_NAMES.factcheck}, ${n} ${one ? 'check' : 'checks'}`,
  perspectives: (n, one) => `${FEATURE_NAMES.perspectives}, ${n} ${one ? 'comparison' : 'comparisons'}`,
};

function historyTitle(item: CreditHistoryItem): string {
  const { reason } = item;
  if (reason !== 'classify' && reason !== 'factcheck' && reason !== 'perspectives') return HISTORY[reason];
  const units = item.posts ?? 0;
  return USAGE[reason](COUNT.format(units), units === 1);
}
