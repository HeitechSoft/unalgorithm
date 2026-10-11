import type { AIErrorCode, PlatformId, PostKey } from '@unalgorithm/protocol';
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
