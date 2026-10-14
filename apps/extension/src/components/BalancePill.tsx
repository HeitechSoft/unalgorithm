import { balanceLine } from '@unalgorithm/core';
import { Badge, Coins } from '@unalgorithm/ui';
import type { PublicBalance } from '../background/server-balance.ts';

/**
 * The account's credit balance (R31): in the popup footer and under the Settings account row, never in the feed. It
 * opens the server's account page, the `accountUrl` the background allows (CL2-10); without one it only shows.
 */
export function BalancePill({ balance, onOpen }: { balance: PublicBalance; onOpen?(): void }) {
  const text = balanceLine(balance.balanceMicros, new Date());
  const opens = !!onOpen && balance.accountUrl !== null;
  return (
    <button
      type="button"
      className="ua-button ua-button--plain ua-button--sm"
      aria-label={`Credit balance: ${text}.${opens ? ' Open your account.' : ''}`}
      disabled={!opens}
      onClick={onOpen}
      style={{ paddingInline: 4 }}
    >
      <Badge tone={balance.empty ? 'danger' : balance.low ? 'warning' : 'neutral'}>
        <Coins aria-hidden="true" style={{ width: 12, height: 12, marginInlineEnd: 4 }} />
        {text}
      </Badge>
    </button>
  );
}

/** True when the balance is low and the banner has not been shown on `today` (a `dateKey()` string). */
export function shouldShowLowBalance(balance: PublicBalance | undefined, lastShownOn: string | null, today: string): boolean {
  return !!balance && balance.low && lastShownOn !== today;
}
