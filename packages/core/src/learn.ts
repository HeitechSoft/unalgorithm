import { clamp } from './util.ts';

/**
 * What the user taught UnAlgorithm with "More like this" / "Less like this". Topic weights apply instantly,
 * without any AI call; with AI on, a few rated examples also go into the next profile snapshot.
 */
export interface FeedbackEvent {
  id: string;
  at: number;
  verdict: 'more' | 'less';
  topics: string[];
  /** Short neutral summary for the AI profile (from the classification reason), never raw post text. */
  summary?: string;
  /**
   * True when a server may receive the rated post (`serverMayReceive`), so its summary may go to one too (R23).
   * Missing on ratings of Facebook posts that aren't public and on ratings recorded before this field existed.
   */
  shareable?: boolean;
}

export interface LearnedPrefs {
  /** topic → weight in [-3, 3]. */
  weights: Record<string, number>;
  events: FeedbackEvent[];
  decayedAt: number;
}

export const EMPTY_LEARNED: LearnedPrefs = { weights: {}, events: [], decayedAt: 0 };

const MAX_EVENTS = 50;
const MAX_TOPICS = 100;
const WEEK_MS = 7 * 24 * 3600_000;

export function normalizeTopic(t: string): string {
  return t.trim().toLowerCase().slice(0, 32);
}

export function applyFeedback(prefs: LearnedPrefs, ev: FeedbackEvent): LearnedPrefs {
  const weights = { ...prefs.weights };
  const delta = ev.verdict === 'more' ? 1 : -1;
  for (const raw of ev.topics) {
    const t = normalizeTopic(raw);
    if (t) weights[t] = clamp((weights[t] ?? 0) + delta, -3, 3);
  }
  // Keep the strongest opinions when there are too many topics.
  const trimmed = Object.entries(weights)
    .filter(([, w]) => w !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, MAX_TOPICS);
  return { ...prefs, weights: Object.fromEntries(trimmed), events: [ev, ...prefs.events].slice(0, MAX_EVENTS) };
}

/** Fade old opinions by 10 % a week so the feed can change with you. */
export function decay(prefs: LearnedPrefs, now = Date.now()): LearnedPrefs {
  const weeks = Math.floor((now - (prefs.decayedAt || now)) / WEEK_MS);
  if (!prefs.decayedAt) return { ...prefs, decayedAt: now };
  if (weeks < 1) return prefs;
  const factor = 0.9 ** weeks;
  const weights = Object.fromEntries(
    Object.entries(prefs.weights)
      .map(([t, w]) => [t, Math.round(w * factor * 100) / 100] as const)
      .filter(([, w]) => Math.abs(w) >= 0.1),
  );
  return { ...prefs, weights, decayedAt: prefs.decayedAt + weeks * WEEK_MS };
}

/** Relevance adjusted by learned topic weights: ±8 per point, capped at ±24. */
export function adjustRelevance(relevance: number, topics: readonly string[], weights: Record<string, number>): number {
  const sum = topics.reduce((acc, t) => acc + (weights[normalizeTopic(t)] ?? 0), 0);
  return clamp(Math.round(relevance + clamp(8 * sum, -24, 24)), 0, 100);
}
