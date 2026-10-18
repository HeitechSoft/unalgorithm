/**
 * The source list UnEcho Chamber runs on (the one the person chose: unAlgorithm Cloud's or their own), whether it can,
 * and the check that keeps every lean shown to the person that list's own. Lean labels come only from a source list
 * people set, never from a model or a server.
 */
import type { Settings } from '@unalgorithm/core';
import {
  type ListProblem,
  listBalance,
  listProblems,
  listProblemText,
  officialSourceList,
  outletForHost,
  ownSourceList,
  type SourceList,
  wireList,
} from '@unalgorithm/outlets';
// `@unalgorithm/outlets` is `sideEffects: false`, and MODE is a build-time constant: store and development bundles
// drop the fixture with the branch below.
import { FIXTURE_OFFICIAL_LIST } from '@unalgorithm/outlets/testing';
import { type LeanBucket, type OfficialList, OfficialListSchema, type PerspectivesResult } from '@unalgorithm/protocol';
import type { StoredOfficialList } from './storage.ts';

/** `raw` as a published source list when it passes `OfficialListSchema` (unknown fields dropped) and the list rules. */
export function validOfficialList(raw: unknown): OfficialList | null {
  const parsed = OfficialListSchema.safeParse(raw);
  return parsed.success && listProblems(parsed.data.outlets).length === 0 ? parsed.data : null;
}

/**
 * unAlgorithm Cloud's source list as this build may use it: the fictional fixture in e2e builds (which never fetch),
 * else the last good copy the background stored (`officialListItem`), checked again because content scripts can write
 * `storage.local` (ADR 0005). Null before the first good copy. Every reader of the Cloud's list goes through here.
 */
export function storedOfficialList(stored: StoredOfficialList): OfficialList | null {
  if (import.meta.env.MODE === 'e2e') return FIXTURE_OFFICIAL_LIST;
  return stored?.list ? validOfficialList(stored.list) : null;
}

/**
 * The chosen list (decision D100): the Cloud's stored copy (`storedOfficialList`, so the fixture in e2e builds) or the
 * person's own (`settings.perspectives.outlets`). Null: the Cloud's is chosen and none is downloaded yet.
 */
export function chosenList(settings: Pick<Settings, 'perspectives'>, official: OfficialList | null): SourceList | null {
  if (settings.perspectives.list === 'own') return ownSourceList(settings.perspectives.outlets);
  return official ? officialSourceList(official) : null;
}

/**
 * UnEcho Chamber may run on `list` (decision D103): at least one outlet with a lean, no `listProblems`, and its wire
 * list within the caps. Balance warnings never block.
 */
export function listReady(list: SourceList | null): list is SourceList {
  return list !== null && !listBalance(list).empty && listProblems(list.outlets).length === 0 && wireList(list) !== null;
}

/** One of a list's `listProblems`, with the outlet's name on the list (null for a cap) and the words people read. */
export interface NamedListProblem extends ListProblem {
  name: string | null;
  text: string;
}

/**
 * `list`'s problems in words that name each outlet by its name. `listProblemText` names it by id, and an own list's ids
 * are uuidv7s that mean nothing to the person; a repeated id is about the id itself, so its words keep it. Each keeps
 * its outlet's id, the way to that outlet in the editor.
 */
export function namedListProblems(list: Pick<SourceList, 'outlets'>): NamedListProblem[] {
  const names = new Map(list.outlets.map((o) => [o.id, o.name]));
  return listProblems(list.outlets).map((p) => {
    const name = p.outletId === null ? null : (names.get(p.outletId) ?? null);
    const text = listProblemText(name === null || p.code === 'duplicate-id' ? p : { ...p, outletId: name });
    return { ...p, name, text };
  });
}

/** "Your list", "unAlgorithm Cloud's list": a list's name in a balance notice. */
export function listName(kind: SourceList['kind']): string {
  return kind === 'own' ? 'Your list' : "unAlgorithm Cloud's list";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * `result` with each source's `outletId` and `outlet` taken from `sent`, when every lean in it is `sent`'s: source ids
 * are unique; each source's domain and URL host map (`outletForHost`) to one outlet of `sent` that has a lean equal to the
 * source's bucket; each coverage row lists only sources of its own bucket; and the result names `sent` (`list` is
 * `sent.kind`, `registryVersion` is `sent.version`). Otherwise null. A server (anyone's, any release) names outlets by
 * web address and can never put a lean in front of the person that the list they chose does not hold; the names shown
 * are always the list's own.
 */
export function matchLeans(result: PerspectivesResult, sent: SourceList): PerspectivesResult | null {
  if (result.list !== sent.kind || result.registryVersion !== sent.version) return null;
  const buckets = new Map<string, LeanBucket>();
  const sources: PerspectivesResult['sources'] = [];
  for (const source of result.sources) {
    // A repeated id would let a coverage row or a citation resolve to a source of another bucket.
    if (buckets.has(source.id)) return null;
    const outlet = outletForHost(sent, source.domain);
    if (!outlet?.lean || outlet.lean.bucket !== source.bucket) return null;
    if (outletForHost(sent, hostOf(source.url))?.id !== outlet.id) return null;
    buckets.set(source.id, source.bucket);
    sources.push({ ...source, outletId: outlet.id, outlet: outlet.name });
  }
  if (!result.coverage.every((row) => row.sourceIds.every((id) => buckets.get(id) === row.bucket))) return null;
  return { ...result, sources };
}
