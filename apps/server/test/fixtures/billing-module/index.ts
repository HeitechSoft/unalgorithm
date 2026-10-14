/**
 * A billing module for tests, never shipped (CL2-05). The server's tests and the extension's end-to-end test run it with
 * `BILLING=module` and `BILLING_MODULE=<absolute path to this file>`, so the module path is exercised without the
 * private code. It keeps the rule the private module keeps: only types come from the server, and every value it uses
 * arrives through `host`.
 *
 * Balances live in memory, per provider: each account starts at `BILLING_FIXTURE_START_MICROS` (default $1, all of it
 * starter credit), a classify costs 100 micro-dollars a post (never more than is left), and an empty balance is refused.
 */
import type { CreditAccount, CreditBalance } from '@unalgorithm/protocol';
import type { Hono } from 'hono';
import type { BillingHost } from '../../../src/billing/host.ts';
import type { BillingDecision, BillingProvider, Settlement } from '../../../src/billing/provider.ts';
import type { AppEnv } from '../../../src/http/app.ts';

const MICROS_PER_POST = 100;
const DEFAULT_START_MICROS = 1_000_000;

/** The module's own configuration error: by contract its message names variables, never their values. */
class BillingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingConfigError';
  }
}

export async function createBillingProvider(host: BillingHost): Promise<BillingProvider> {
  const { protocol } = host;
  const start = startMicros(host.env.BILLING_FIXTURE_START_MICROS);
  const balances = new Map<string, number>();
  const balanceOf = (userId: string) => balances.get(userId) ?? start;
  /** All of it promotional: the starter credit, still held, with no expiry here. */
  const creditBalance = (userId: string): CreditBalance => {
    const micros = balanceOf(userId);
    return protocol.CreditBalanceSchema.parse({
      v: 1,
      balanceMicros: micros,
      promoMicros: micros,
      purchasedMicros: 0,
      promoExpiresAt: null,
      starter: 'active',
    });
  };

  return {
    id: 'fixture',
    advertised: true,
    async check({ userId }): Promise<BillingDecision> {
      if (balanceOf(userId) <= 0) return { kind: 'refuse', code: 'insufficient-credits', message: 'The balance is empty.' };
      return { kind: 'allow' };
    },
    async settle({ userId, posts }): Promise<Settlement> {
      const balance = balanceOf(userId);
      const chargedMicros = Math.min(posts * MICROS_PER_POST, balance);
      balances.set(userId, balance - chargedMicros);
      return { chargedMicros, balanceMicros: balance - chargedMicros };
    },
    async release() {},
    async balance(userId) {
      return { balanceMicros: balanceOf(userId) };
    },
    mount(app: Hono<AppEnv>) {
      app.get(protocol.CREDIT_BALANCE_PATH, host.auth.device, (c) => {
        c.header('Cache-Control', 'no-store');
        return c.json(creditBalance(c.get('account').userId));
      });
      app.get(protocol.CREDIT_ACCOUNT_PATH, host.auth.webSession, (c) => {
        c.header('Cache-Control', 'no-store');
        const account: CreditAccount = protocol.CreditAccountSchema.parse({
          v: 1,
          balance: creditBalance(c.get('webUser').userId),
          history: [],
        });
        return c.json(account);
      });
    },
  };
}

/** The start balance: a whole number of micro-dollars, 0 or more. */
function startMicros(value: string | undefined): number {
  if (value === undefined) return DEFAULT_START_MICROS;
  const micros = /^\s*\d+\s*$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(micros)) {
    throw new BillingConfigError('BILLING_FIXTURE_START_MICROS must be a whole number of micro-dollars');
  }
  return micros;
}
