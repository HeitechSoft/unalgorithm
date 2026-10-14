/**
 * A billing module for tests, never shipped (CL2-05). The server's tests and the extension's end-to-end test run it with
 * `BILLING=module` and `BILLING_MODULE=<absolute path to this file>`, so the module path is exercised without the
 * private code. It keeps the rule the private module keeps: only types come from the server, and every value it uses
 * arrives through `host`.
 *
 * Balances live in memory, in one map per process: each account starts at `BILLING_FIXTURE_START_MICROS` (default $1, all
 * of it starter credit), a classify costs 100 micro-dollars a post (never more than is left), and an empty balance is
 * refused. One command, `balance --user <id>`, runs through the server's billing CLI (CL2-06).
 *
 * A real module prices a request with `host.protocol.priceCardsAt(checkedAt)`; this one charges a flat 100 micro-dollars
 * a post. It settles only with the instant its check received, so every test that classifies through it proves the
 * instant arrives.
 */
import type { CreditAccount, CreditBalance } from '@unalgorithm/protocol';
import type { Hono } from 'hono';
import type { BillingHost } from '../../../src/billing/host.ts';
import type { BillingDecision, BillingProvider, Settlement } from '../../../src/billing/provider.ts';
import type { AppEnv } from '../../../src/http/app.ts';

const MICROS_PER_POST = 100;
const DEFAULT_START_MICROS = 1_000_000;
const USAGE = 'usage: balance --user <id>';

/**
 * What each account has left, by user id: shared by every provider this module makes in a process and by `runCli`. A
 * CLI process makes no provider, so there the map is empty and every account shows the start balance. Keys are the
 * server's random user ids, so tests that share a process never see each other's balances.
 */
const balances = new Map<string, number>();

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
  const balanceOf = (userId: string) => balances.get(userId) ?? start;
  /** The instant each allowed request's check received, by request id (unique), until it is settled or released. */
  const checkedAtByRequest = new Map<string, number>();
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
    async check({ userId, requestId, checkedAt }): Promise<BillingDecision> {
      if (balanceOf(userId) <= 0) return { kind: 'refuse', code: 'insufficient-credits', message: 'The balance is empty.' };
      checkedAtByRequest.set(requestId, checkedAt.getTime());
      return { kind: 'allow' };
    },
    async settle({ userId, requestId, posts, checkedAt }): Promise<Settlement> {
      const checked = checkedAtByRequest.get(requestId);
      checkedAtByRequest.delete(requestId);
      if (checked === undefined || checked !== checkedAt.getTime()) {
        throw new Error('settle without the instant its check received');
      }
      const balance = balanceOf(userId);
      const chargedMicros = Math.min(posts * MICROS_PER_POST, balance);
      balances.set(userId, balance - chargedMicros);
      return { chargedMicros, balanceMicros: balance - chargedMicros };
    },
    async release({ requestId }) {
      checkedAtByRequest.delete(requestId);
    },
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

/** The module's commands: `balance --user <id>` prints `balance <micros>`; anything else prints the usage (exit code 2). */
export async function runCli(args: readonly string[], host: BillingHost, out: (line: string) => void): Promise<number> {
  const [command, flag, userId, ...rest] = args;
  if (command !== 'balance' || flag !== '--user' || !userId || rest.length > 0) {
    out(USAGE);
    return 2;
  }
  out(`balance ${balances.get(userId) ?? startMicros(host.env.BILLING_FIXTURE_START_MICROS)}`);
  return 0;
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
