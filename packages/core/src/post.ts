import type { AUDIENCES, AuthorKind, MediaKind, PlatformId, PostKey } from '@unalgorithm/protocol';

/** Whether the user follows the author. `unknown` never hides a post (fail open). */
export type Relationship = 'followed' | 'not-followed' | 'unknown';

/** Facebook shows who can see a post; non-public posts are never sent to a cloud AI. */
export type Audience = (typeof AUDIENCES)[number];

/** Platform-neutral noise signals an adapter can detect from the rendered page. */
export interface PostSignals {
  sponsored: boolean;
  suggested: boolean;
  /** Shown because someone in your network reacted or commented ("Jane likes this"). */
  networkActivity: boolean;
  /** Shown because someone reposted it ("Jane reposted this"). */
  reshare: boolean;
  unjoinedGroup: boolean;
  reel: boolean;
}

export const NO_SIGNALS: PostSignals = {
  sponsored: false,
  suggested: false,
  networkActivity: false,
  reshare: false,
  unjoinedGroup: false,
  reel: false,
};

/** Which detector found a signal. Ids only, never content; powers "Why?" and diagnostics. */
export interface Evidence {
  signal: keyof PostSignals | 'relationship' | 'module';
  detector: string;
  strength: 'strong' | 'medium' | 'weak';
}

/** One feed post as read from the page. Built by a platform adapter; never contains the viewer's own data. */
export interface PostData {
  id: PostKey;
  platform: PlatformId;
  /** Link to the post, or to the author's posts when the page shows no permalink. */
  permalink?: string;
  /** Display only. Never sent to AI or stored in caches. */
  author: { name?: string; url?: string; kind: AuthorKind; relationship: Relationship };
  group?: { name?: string; joined: boolean | null };
  /** The context line above the post ("Jane Doe likes this"), shown in "Why?". */
  contextLine?: string;
  signals: PostSignals;
  evidence: Evidence[];
  text: string;
  textComplete: boolean;
  /** Names of people and pages tagged or linked inside the text. Only used to mask them before AI; never sent. */
  mentions?: string[];
  lang?: string;
  media: MediaKind;
  sharedLink?: { url: string; domain: string; title?: string };
  audience?: Audience;
  age?: { text: string; hours?: number };
  /** Extraction quality, used by the health monitor. */
  quality: { authorFound: boolean; textFound: boolean };
}

export const MODULE_KINDS = [
  'people-you-may-know',
  'reels',
  'stories',
  'jobs',
  'games',
  'groups',
  'pages',
  'newsletters',
  'sponsored-rail',
  'promo',
  'other',
] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];

/** A feed item that is not a post (People You May Know, a Reels tray, a jobs carousel...). */
export interface ModuleInfo {
  kind: ModuleKind;
  title?: string;
}
