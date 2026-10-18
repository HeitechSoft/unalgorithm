import { FEATURE_NAMES } from '@unalgorithm/protocol';
import { Button } from './controls.tsx';
import { Banner } from './feedback.tsx';

/**
 * A source list's balance (`listBalance` in `@unalgorithm/outlets`, passed in as plain props, so `ui` needs no list
 * code): a list with no lean can't be used; a list with warnings isn't balanced, which warns and never blocks.
 * `name` says which list: "unAlgorithm Cloud's list", "Your list".
 */
export function BalanceNotice({ name, empty, warnings }: { name: string; empty: boolean; warnings: readonly string[] }) {
  if (empty) {
    return <Banner tone="warning" title={`${name} has no outlets with a lean, so ${FEATURE_NAMES.perspectives} can't use it.`} />;
  }
  if (warnings.length === 0) return null;
  return (
    <Banner tone="warning" title={`${name} isn't balanced`}>
      <ul>
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </Banner>
  );
}

/** One list problem as the notice shows it: plain words naming the outlet by its name, and a way to that outlet. */
export interface ListProblemItem {
  /** Unique within the notice: the problem's code and outlet. */
  id: string;
  text: string;
  fix?: { label: string; onFix(): void };
}

/**
 * A source list that breaks the list rules (`listProblems` in `@unalgorithm/outlets`: a web address in two outlets or
 * inside another's, over a cap), which UnEcho Chamber can't use until it is fixed. An own list gets one from sync: two
 * devices can each add an outlet with the same web address, or together go past the caps. `name` as for
 * `BalanceNotice`; `action` leads to where it can be fixed. Copy is a draft (D110).
 */
export function ListProblemsNotice({
  name,
  problems,
  action,
}: {
  name: string;
  problems: readonly ListProblemItem[];
  action?: { label: string; onAction(): void };
}) {
  if (problems.length === 0) return null;
  return (
    <Banner tone="warning" title={`${name} needs fixing, so ${FEATURE_NAMES.perspectives} can't use it.`} action={action}>
      <ul>
        {problems.map((p) => (
          <li key={p.id}>
            <span>{p.text}</span>
            {p.fix ? (
              <>
                {' '}
                <Button variant="plain" size="sm" onClick={p.fix.onFix}>
                  {p.fix.label}
                </Button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </Banner>
  );
}
