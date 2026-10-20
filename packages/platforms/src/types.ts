import type { ModuleInfo, PostData } from '@unalgorithm/core';
import type { PlatformId } from '@unalgorithm/protocol';

export interface InspectContext<M> {
  /** Text markers for the page's UI language, or null when that language is not supported (text detectors off). */
  markers: M | null;
  now: Date;
}

/**
 * Ids of things an adapter noticed while reading an item that aren't evidence for a signal (ADR 0009 §9): a near-miss
 * label, an unrecognised header line, which locator found a slot. Each must be in `ids.observations` and in the protocol
 * registry (`OBSERVATION_IDS`). Counted for health and reports; never content.
 */
export type Observations = readonly string[];

export type InspectResult =
  | { kind: 'post'; post: PostData; observations?: Observations }
  | { kind: 'module'; module: ModuleInfo; observations?: Observations }
  /**
   * Still loading (a skeleton card): inspect again when it changes. `offscreen`: a slot the platform emptied or
   * virtualised after it scrolled away; the controller keeps its last decision, and health counts it as what it was
   * last read as (a post or a panel), or leaves it out when it was never read.
   */
  | { kind: 'pending'; offscreen?: boolean }
  /** Not a feed item we handle (the composer, a spacer). */
  | { kind: 'ignore'; observations?: Observations };

/**
 * How an address relates to the feed (ADR 0009 §3): the feed itself; a candidate that may be the feed at a new
 * address (the controller starts only on a strong home signature, otherwise the watchdog watches); or not the feed.
 */
export type RouteClass = 'feed' | 'feed-candidate' | 'not-feed';

/** How sure an adapter is that a document is the platform's home feed, from its structure alone. */
export type HomeSignature = 'strong' | 'weak' | null;

/** Every id an adapter can emit, by kind: each list is a subset of the protocol registry (`report-codes.ts`). */
export interface AdapterIds {
  readonly detectors: readonly string[];
  readonly observations: readonly string[];
  readonly strategies: readonly string[];
  readonly landmarks: readonly string[];
}

/** The item discovery strategy that won, and whether it is a fallback (cautious mode: only strong signals hide). */
export interface DiscoveryState {
  strategy: string;
  fallback: boolean;
}

/**
 * Everything platform-specific about reading a feed. The feed controller is the same for every platform; an
 * adapter only finds feed items and reads them.
 *
 * Adapters are strictly read-only: `inspect` never clicks, scrolls, focuses or changes the page. The shared
 * contract check (`checkAdapterContract` in `@unalgorithm/platforms/testing`) enforces this.
 */
export interface PlatformAdapter<M = unknown> {
  readonly id: PlatformId;
  /** Shown in diagnostics, e.g. "linkedin@2026.10.1". Bump when detection logic changes. */
  readonly version: string;
  /** True on the feed page (not on a single post, a profile or search): `classifyRoute(url) === 'feed'` when it exists. */
  isFeedPage(url: URL): boolean;
  /**
   * The address's route class (ADR 0009 §3). Optional so adapters without it keep working (`routeOf` falls back to
   * `isFeedPage`); LinkedIn and Facebook must have it (the contract test checks).
   */
  classifyRoute?(url: URL): RouteClass;
  /** Whether the page is the home feed by structure, for a candidate route: `strong` lets the controller start. */
  homeSignature?(doc: Document): HomeSignature;
  /** A signed-in page shell is present, so a missing feed means breakage, not a login page or a consent wall. */
  signedIn?(doc: Document): boolean;
  /** Every detector, observation, strategy and landmark id this adapter can emit. */
  readonly ids?: AdapterIds;
  /** The discovery strategy currently winning, or null before the first discovery (phase B). */
  discovery?(): DiscoveryState | null;
  /** Run full item discovery again (the controller calls it on each health tick); read-only, about 5 ms at most. */
  rediscover?(doc: Document): void;
  /** Smallest stable element that contains the feed, or null while it is not on the page yet. */
  feedScope(doc: Document): HTMLElement | null;
  /** Feed items (posts and module cards), outermost only, in page order. */
  findItems(scope: HTMLElement): HTMLElement[];
  /** The feed item containing `node`, if any. Hot path: O(depth). */
  itemRootOf(node: Node, scope: HTMLElement): HTMLElement | null;
  inspect(el: HTMLElement, ctx: InspectContext<M>): InspectResult;
  /** Non-post elements placed between feed items (LinkedIn's People You May Know rows). */
  siblingModules?(items: readonly HTMLElement[], ctx: InspectContext<M>): Array<{ el: HTMLElement; module: ModuleInfo }>;
  /** Noise outside the feed list (Facebook's Stories tray, right-rail ads). */
  extraRegions?(doc: Document, ctx: InspectContext<M>): Array<{ el: HTMLElement; module: ModuleInfo }>;
  /** The platform's infinite-scroll trigger, for re-arming when collapsed posts stall loading. */
  loadMoreMarker?(scope: HTMLElement, doc: Document): HTMLElement | null;
  /** A click on an element matching this ("See more") re-reads the post once. */
  readonly expanderSelector?: string;
  /** Landmark counts for diagnostics. Numbers only, never content. */
  probe(doc: Document, scope: HTMLElement | null): Record<string, number>;
  theme(doc: Document): 'light' | 'dark';
  /** Markers for a UI language (BCP 47), or null if unsupported. */
  markersFor(lang: string): M | null;
}
