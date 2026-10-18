import { FEATURE_NAMES, type ListKind, METHODOLOGY_PAGE, SOURCE_REPO, siteUrl } from '@unalgorithm/protocol';
import type { FactcheckEntry } from './storage.ts';

/**
 * The links under a finished fact-check or UnEcho Chamber result in the side panel (P3-69, F30): how the feature works,
 * and the correction form on GitHub. An extension page module: the version is passed in. With `content/report.ts`, the
 * only place that builds a GitHub issue URL.
 */
export interface SheetLink {
  text: string;
  href: string;
}

/** The correction form's `list` options (P3-68), by list kind: the exact labels GitHub matches. */
export const LIST_OPTIONS: Readonly<Record<ListKind, string>> = Object.freeze({
  cloud: "unAlgorithm Cloud's list",
  own: 'My own list',
});

/**
 * The correction form, prefilled with technical facts only (decisions D88, D107): the feature's name, this extension's
 * version, the result's prompt version and, for UnEcho Chamber, which list it used. Never anything from the post, the
 * result or the person, and no date (it would say when the person read the post).
 */
export function correctionUrl(i: {
  task: 'factcheck' | 'perspectives';
  extensionVersion: string;
  promptVersion: number;
  list?: ListKind;
}): string {
  const params = new URLSearchParams({
    template: 'correction.yml',
    feature: FEATURE_NAMES[i.task],
    version: i.extensionVersion,
    prompt: String(i.promptVersion),
    ...(i.list ? { list: LIST_OPTIONS[i.list] } : {}),
  });
  return `${SOURCE_REPO}/issues/new?${params.toString()}`;
}

/** The links under a finished result; [] for a running or failed entry, or one without a result. Copy is a draft (D110). */
export function sheetLinks(entry: FactcheckEntry, extensionVersion: string): SheetLink[] {
  if (entry.status !== 'done') return [];
  const howItWorks = (task: 'factcheck' | 'perspectives'): SheetLink => ({
    text: `How ${FEATURE_NAMES[task]} works`,
    href: siteUrl(METHODOLOGY_PAGE),
  });
  if (entry.task === 'perspectives') {
    const p = entry.perspectives;
    if (!p) return [];
    return [
      howItWorks('perspectives'),
      {
        text: 'Report a mistake',
        href: correctionUrl({ task: 'perspectives', extensionVersion, promptVersion: p.promptVersion, list: p.list }),
      },
    ];
  }
  const r = entry.result;
  if (!r) return [];
  return [
    howItWorks('factcheck'),
    {
      text: 'Report a wrong verdict',
      href: correctionUrl({ task: 'factcheck', extensionVersion, promptVersion: r.promptVersion }),
    },
  ];
}
