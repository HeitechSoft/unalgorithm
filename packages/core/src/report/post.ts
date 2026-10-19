import { REPORT_ID_PATTERN, type ReportPost, type TextBucket } from '@unalgorithm/protocol';
import type { PostData } from '../post.ts';
import type { FilterDecision } from '../reasons.ts';

/** Posts with fewer characters than this count as `short`. */
export const SHORT_TEXT_CHARS = 200;
const MAX_EVIDENCE = 24;

/** A post's text as a size only. */
export function textBucket(text: string | undefined): TextBucket {
  const length = text?.trim().length ?? 0;
  return length === 0 ? 'none' : length < SHORT_TEXT_CHARS ? 'short' : 'long';
}

/**
 * What a *Wrong call?* report says about the post (ADR 0009 §4): why it was hidden and by whom, which detectors saw
 * what and how strongly, the author's kind and whether the person follows them, the media kind and a text size. Never
 * the text, the author's or anyone's name, a link, the post's id, a keyword or a topic: only codes and enums are read.
 * `post` is null for a hidden feed panel, which has no author or text.
 */
export function summarizePostForReport(
  post: PostData | null,
  decision: Pick<FilterDecision, 'reason' | 'source' | 'module'>,
): ReportPost {
  const seen = new Set<string>();
  const evidence: ReportPost['evidence'] = [];
  for (const e of post?.evidence ?? []) {
    // Ids that don't fit the wire pattern (an adapter bug) would make the whole report invalid: leave them out.
    const key = `${e.detector}\u0000${e.strength}`;
    if (!REPORT_ID_PATTERN.test(e.detector) || e.detector.length > 64 || seen.has(key)) continue;
    seen.add(key);
    evidence.push({ detector: e.detector, strength: e.strength });
    if (evidence.length === MAX_EVIDENCE) break;
  }
  return {
    reason: decision.reason,
    source: decision.source,
    evidence,
    authorKind: post?.author.kind ?? 'unknown',
    relationship: post?.author.relationship ?? 'unknown',
    media: post?.media ?? 'none',
    text: textBucket(post?.text),
    ...(decision.module ? { module: decision.module.kind } : {}),
  };
}
