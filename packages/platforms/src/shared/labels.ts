/**
 * Tolerant label patterns (ADR 0009 §9). Platforms reword their labels ("Promoted • Partnership with LinkedIn",
 * "Ad · Paid"), so an exact regex stops matching and ads slip through unnoticed. A `LabelPattern` names the label's
 * head words, the tails it is known to take and the words that make it something else; `matchLabel` then tells an
 * exact or known label (strong evidence) from a near miss (medium evidence, and a report-only observation), so a new
 * wording keeps working and gets reported. Labels are only ever read from label positions (an age slot, a header,
 * a header button), never from post text.
 */

/** Separators between a label's parts: dots, middle dots, bullets, bars, colons and dashes. */
const SEPARATORS = '.·•‧∙⋅・|:\\-\u2010-\u2015\u2212';
const EDGE_SEPARATORS = new RegExp(`^[\\s${SEPARATORS}]+|[\\s${SEPARATORS}]+$`, 'gu');
/**
 * Invisible characters that split or disguise a label: soft hyphen, combining grapheme joiner (U+034F), Arabic letter
 * mark, Hangul fillers, Mongolian vowel separator, zero-width characters, bidi controls, word joiners, BOM.
 */
const INVISIBLE =
  /[\u00AD\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0]|\u034F/g;
/** A word: letters and digits, with inner apostrophes ("Today's"). Punctuation such as "+" never counts as a word. */
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** Longer text is never a label (a sentence or a post line in a label position). */
export const MAX_LABEL_CHARS = 80;
/** Unknown words a near miss may add to a head, unless the pattern says otherwise. */
export const DEFAULT_NEAR_WORDS = 4;

export interface LabelPattern {
  /** Names the pattern in observations (`li.label.<id>.near`). */
  readonly id: string;
  /** What the label starts with: `promoted`, `sponsored`. Lowercase; may be several words (`suggested for you`). */
  readonly heads: readonly string[];
  /** Known continuations, each matching whatever follows it: `by` ("Promoted by Acme"), `partnership with`. */
  readonly tails?: readonly string[];
  /** A first word after the head that makes it not this label: `to` ("Promoted to Director"). */
  readonly notTails?: readonly string[];
  /** At most this many unknown words after the head still make a near miss (default DEFAULT_NEAR_WORDS; 0: none). */
  readonly nearWords?: number;
  /** Words allowed before the head ("request to" before "join"). Punctuation such as "+ " is ignored anyway. */
  readonly prefix?: string;
  /**
   * A near miss needs a separator straight after the head ("Promoted • Brand content", "Promoted | Acme"), so a line
   * that only starts with the head word, such as an author's headline ("Sponsored Products Manager at Amazon"), is
   * not one.
   */
  readonly nearAfterSeparator?: boolean;
}

/** `exact`: just the head. `known`: the head and a known tail. `near`: the head and a few unknown words. */
export type LabelMatch = 'exact' | 'known' | 'near';

export interface LabelHit {
  /** The pattern's id. */
  id: string;
  match: LabelMatch;
  /** The head that matched, as the pattern spells it. */
  head: string;
  /** The known tail, for `known`. */
  tail?: string;
  /** Words after the head (and tail) that the pattern doesn't know. */
  extra: number;
  /** A separator follows the head ("Promoted • Partnership with", "Promoted | Acme"), as in a label, unlike a sentence. */
  separated: boolean;
  /** The label after `normaliseLabel`: what a near-miss hash is taken from. */
  label: string;
}

/**
 * A label as the page shows it, made comparable: NFKC (look-alike letters become plain ones), invisible characters
 * removed, whitespace collapsed, leading and trailing separators trimmed ("• Promoted •" is "Promoted"). Case is kept.
 */
export function normaliseLabel(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').replace(EDGE_SEPARATORS, '');
}

const wordsOf = (text: string): string[] => text.toLowerCase().match(WORD) ?? [];
const SEPARATOR_NEXT = new RegExp(`^\\s*[${SEPARATORS}]`, 'u');

/** Whether a separator follows the first `n` words of `label`. */
function separatedAfter(label: string, n: number): boolean {
  let seen = 0;
  for (const word of label.matchAll(WORD)) {
    if (++seen === n) return SEPARATOR_NEXT.test(label.slice((word.index ?? 0) + word[0].length));
  }
  return false;
}

function startsWith(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.length <= words.length && prefix.every((w, i) => words[i] === w);
}

/** Longest first, so "suggested for you" wins over "suggested" and "partnership with" over "partnership". */
const byLength = (phrases: readonly string[]) =>
  phrases.map((p) => ({ phrase: p, words: wordsOf(p) })).sort((a, b) => b.words.length - a.words.length);

/**
 * Whether `text` is the pattern's label, and how closely. Words are compared whole and without case, so "Promotedness"
 * and "Following" never match "promoted" and "follow", and separators or punctuation between words don't matter.
 */
export function matchLabel(text: string, pattern: LabelPattern): LabelHit | null {
  const label = normaliseLabel(text);
  if (!label || label.length > MAX_LABEL_CHARS) return null;
  let words = wordsOf(label);
  const prefix = wordsOf(pattern.prefix ?? '');
  const prefixed = startsWith(words, prefix);
  if (prefixed) words = words.slice(prefix.length);
  const head = byLength(pattern.heads).find((h) => startsWith(words, h.words));
  if (!head) return null;
  const rest = words.slice(head.words.length);
  const separated = rest.length > 0 && separatedAfter(label, (prefixed ? prefix.length : 0) + head.words.length);
  const hit = { id: pattern.id, head: head.phrase, label, separated };
  if (rest.length === 0) return { ...hit, match: 'exact', extra: 0 };
  if (pattern.notTails?.some((w) => w.toLowerCase() === rest[0])) return null;
  const tail = byLength(pattern.tails ?? []).find((t) => startsWith(rest, t.words));
  if (tail) return { ...hit, match: 'known', tail: tail.phrase, extra: rest.length - tail.words.length };
  if (rest.length > (pattern.nearWords ?? DEFAULT_NEAR_WORDS) || (pattern.nearAfterSeparator && !separated)) return null;
  return { ...hit, match: 'near', extra: rest.length };
}

/** The strongest hit among `patterns` (an exact or known label before a near miss), the first one given on a tie. */
export function matchAnyLabel(text: string, patterns: readonly LabelPattern[]): LabelHit | null {
  let best: LabelHit | null = null;
  for (const pattern of patterns) {
    const hit = matchLabel(text, pattern);
    if (hit && hit.match !== 'near') return hit;
    best ??= hit;
  }
  return best;
}

/** Evidence strength for a hit (ADR 0009 §9): an exact or known label is strong, a near miss medium. */
export function labelStrength(hit: LabelHit): 'strong' | 'medium' {
  return hit.match === 'near' ? 'medium' : 'strong';
}
