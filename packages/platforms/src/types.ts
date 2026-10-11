import type { ModuleInfo, PostData } from '@unalgorithm/core';
import type { PlatformId } from '@unalgorithm/protocol';

export interface InspectContext<M> {
  /** Text markers for the page's UI language, or null when that language is not supported (text detectors off). */
  markers: M | null;
  now: Date;
}

export type InspectResult =
  | { kind: 'post'; post: PostData }
  | { kind: 'module'; module: ModuleInfo }
  /** Still loading (a skeleton card): inspect again when it changes. */
  | { kind: 'pending' }
  /** Not a feed item we handle (the composer, a spacer). */
  | { kind: 'ignore' };

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
  /** True on the feed page (not on a single post, a profile or search). */
  isFeedPage(url: URL): boolean;
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
