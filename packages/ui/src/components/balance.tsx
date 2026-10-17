import { FEATURE_NAMES } from '@unalgorithm/protocol';
import { Banner } from './feedback.tsx';

/**
 * A source list's balance (`listBalance` in `@unalgorithm/outlets`, passed in as plain props, so `ui` needs no list
 * code): a list with no lean can't be used; a list with warnings isn't balanced, which warns and never blocks.
 * `name` says which list: "UnAlgorithm Cloud's list", "Your list".
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
