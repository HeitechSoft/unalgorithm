/** Source lists for UnEcho Chamber, browser-safe (the extension bundles this entry): no `node:` import here or below. */
import data from '../data/candidates.json' with { type: 'json' };
import { type Candidates, CandidatesSchema } from './schema.ts';

export * from './balance.ts';
export * from './schema.ts';

let bundled: Candidates | null | undefined;

/** The candidate list shipped in `data/candidates.json`, parsed once; null when it is invalid. It holds no lean. */
export function bundledCandidates(): Candidates | null {
  if (bundled === undefined) {
    const parsed = CandidatesSchema.safeParse(data);
    bundled = parsed.success ? parsed.data : null;
  }
  return bundled;
}
