import type { AIErrorCode, NoticeKind, PlatformId, PostKey } from '@unalgorithm/protocol';
import type { HealthReport } from './health.ts';

export interface HighlightItem {
  id: PostKey;
  permalink?: string;
  author?: string;
  snippet: string;
  relevance?: number;
  matched: string[];
  source: 'ai' | 'keywords' | 'feedback';
}

export interface HiddenItem {
  id: PostKey;
  reasonKey: string;
  label: string;
  author?: string;
  snippet: string;
  permalink?: string;
  ai: boolean;
}

export type AiState = 'off' | 'ready' | 'working' | 'paused' | 'error';

/** Live state of one feed tab, kept in session storage for the popup and side panel. */
export interface TabState {
  platform: PlatformId | null;
  url?: string;
  onFeed: boolean;
  paused: boolean;
  counts: {
    items: number;
    posts: number;
    classified: number;
    /** reasonKey → count */
    hidden: Record<string, number>;
    hiddenTotal: number;
    highlighted: number;
  };
  /** Chip labels for each reasonKey, in the platform's wording. */
  reasonLabels: Record<string, string>;
  hiddenItems: HiddenItem[];
  highlights: HighlightItem[];
  ai: { state: AiState; code?: AIErrorCode; message?: string };
  health: HealthReport;
  /**
   * The breakage notice for this page (ADR 0009 §3), whatever the snoozes: the popup and side panel show it as a banner
   * even when the in-feed card is snoozed. `issues` are the health issue codes behind it.
   */
  notice?: { kind: NoticeKind; issues: string[] };
  /** A page unAlgorithm didn't start on, but whose watchdog found a working feed: "isn't running on this feed". */
  feedLike?: boolean;
  /** Running on an address unAlgorithm didn't know, because the page had a strong home signature (`route-new`). */
  routeNew?: boolean;
  updatedAt: number;
}

export function emptyTabState(): TabState {
  return {
    platform: null,
    onFeed: false,
    paused: false,
    counts: { items: 0, posts: 0, classified: 0, hidden: {}, hiddenTotal: 0, highlighted: 0 },
    reasonLabels: {},
    hiddenItems: [],
    highlights: [],
    ai: { state: 'off' },
    health: { status: 'ok', issues: [], degraded: [] },
    updatedAt: 0,
  };
}
