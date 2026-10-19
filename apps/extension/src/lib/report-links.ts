import type { AISourceConfig } from '@unalgorithm/core';
import {
  CORRECTION_CHOICES,
  CORRECTION_VIA,
  FEATURE_NAMES,
  METHODOLOGY_PAGE,
  REPORT_CHOICES,
  type ReportAiKind,
  type ReportKind,
  siteUrl,
} from '@unalgorithm/protocol';
import type { ReportDraftInput } from './messages.ts';
import { PINNED_CLOUD_ORIGIN } from './server-label.ts';
import type { FactcheckEntry } from './storage.ts';

/**
 * Problem reports as the extension's pages and its background share them (ADR 0009 §2): the links under a finished
 * fact-check or UnEcho Chamber result in the side panel, the correction draft *Report a wrong verdict* and *Report a
 * mistake* open, which answers each kind of report takes, and the AI a report names. Nothing here sends anything: every
 * report goes through the report page, and only its *Send report* click sends it.
 */

/** A link in a sheet's footer (how the feature works), or an action (report a mistake), rendered as a link. */
export type SheetLink = { text: string; href: string } | { text: string; onSelect(): void };

/** The AI source as a report names it: a kind only, never an address, a model or a key. */
export function aiKindOf(source: AISourceConfig | null): ReportAiKind {
  if (!source) return 'off';
  switch (source.kind) {
    case 'on-device':
      return 'on-device';
    case 'server':
      return sameOrigin(source.baseUrl, PINNED_CLOUD_ORIGIN) ? 'cloud' : 'own-server';
    default:
      return 'own-key';
  }
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Which AI made a result being corrected, as the current source says: results don't record it, and on-device AI never
 * makes them. When the source has since been turned off or switched to on-device AI, the person's own key is the
 * likeliest maker (the only other way to run Fact-check), and the correction's words say the rest.
 */
export function correctionVia(source: AISourceConfig | null): (typeof CORRECTION_VIA)[number] {
  const kind = aiKindOf(source);
  return (CORRECTION_VIA as readonly string[]).includes(kind) ? (kind as (typeof CORRECTION_VIA)[number]) : 'own-key';
}

/**
 * The correction draft for a finished result: the feature, the result's prompt version, for UnEcho Chamber which list
 * it used, and which AI made it. Never anything from the post, the result or the person; their words come on the
 * report page. Null for a running or failed entry, or one without a result.
 */
export function correctionDraft(entry: FactcheckEntry, source: AISourceConfig | null): ReportDraftInput | null {
  if (entry.status !== 'done') return null;
  const via = correctionVia(source);
  if (entry.task === 'perspectives') {
    const p = entry.perspectives;
    if (!p) return null;
    return {
      kind: 'correction',
      from: 'sidepanel',
      correction: { feature: 'perspectives', promptVersion: p.promptVersion, list: p.list, via },
    };
  }
  const r = entry.result;
  if (!r) return null;
  return { kind: 'correction', from: 'sidepanel', correction: { feature: 'factcheck', promptVersion: r.promptVersion, via } };
}

/**
 * The links under a finished result: how the feature works, and the correction report (`onReport`, which opens the
 * report page with `correctionDraft`). [] for a running or failed entry, or one without a result.
 */
export function sheetLinks(
  entry: FactcheckEntry,
  onReport: (draft: ReportDraftInput) => void,
  source: AISourceConfig | null,
): SheetLink[] {
  const draft = correctionDraft(entry, source);
  if (!draft?.correction) return [];
  const task = draft.correction.feature;
  return [
    { text: `How ${FEATURE_NAMES[task]} works`, href: siteUrl(METHODOLOGY_PAGE) },
    { text: task === 'perspectives' ? 'Report a mistake' : 'Report a wrong verdict', onSelect: () => onReport(draft) },
  ];
}

/** The answers a report may carry: its kind's, and for a correction, its feature's. */
export function choicesFor(report: {
  kind: ReportKind;
  correction?: { feature: 'factcheck' | 'perspectives' };
}): readonly string[] {
  if (report.kind === 'correction') return report.correction ? CORRECTION_CHOICES[report.correction.feature] : [];
  return REPORT_CHOICES[report.kind];
}

/** One answer only (radio buttons): every kind but a detection report, which ticks as many as apply. */
export function singleChoice(kind: ReportKind): boolean {
  return kind !== 'detection';
}

/**
 * Whether the person must answer before sending. Always, except for a detection report from the in-feed card or from a
 * tab whose content script didn't answer: there the finding speaks for itself (ADR 0009 §2).
 */
export function choiceRequired(report: { kind: ReportKind; from: string }): boolean {
  return report.kind !== 'detection' || !['notice', 'popup-no-script'].includes(report.from);
}

/** Whether `choices` are answers this report may carry, as many as its kind takes. */
export function validChoices(
  report: { kind: ReportKind; from: string; correction?: { feature: 'factcheck' | 'perspectives' } },
  choices: readonly string[],
): boolean {
  const allowed = choicesFor(report);
  if (!choices.every((c) => allowed.includes(c)) || new Set(choices).size !== choices.length) return false;
  if (singleChoice(report.kind) && choices.length > 1) return false;
  return choices.length > 0 || !choiceRequired(report);
}
