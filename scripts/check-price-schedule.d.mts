/** Types for check-price-schedule.mjs, so the strict server tsconfig (no allowJs) accepts its test's import. */
import type { CreditPriceSchedule } from '../packages/protocol/src/index.ts';

/** A schedule and its notice, as a price-schedule.ts exports them; `noticeDays` is undefined when the file has none. */
export interface LoadedSchedule {
  schedule: CreditPriceSchedule;
  noticeDays: number | undefined;
}

/** Imports a price-schedule.ts source (as git shows it) from a new temporary directory, which is then removed. */
export function loadScheduleSource(source: string): Promise<LoadedSchedule>;

export interface CheckDeps {
  /** Runs git in the repository root. */
  git?: (args: readonly string[]) => { status: number | null; stdout: string };
  /** This checkout's schedule; by default the protocol package's `CREDIT_PRICE_SCHEDULE` and `PRICE_NOTICE_DAYS`. */
  head?: { schedule: CreditPriceSchedule; noticeDays: number };
  now?: Date;
  out?: (line: string) => void;
}

/** The CLI. Resolves with the exit code: 0 allowed, 1 a rule fails, 2 the check could not run. */
export function main(argv: readonly string[], deps?: CheckDeps): Promise<number>;
