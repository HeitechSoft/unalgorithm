import { z } from 'zod';

/** Social platforms UnAlgorithm understands. Add a platform here, then an adapter in @unalgorithm/platforms. */
export const PLATFORMS = ['linkedin', 'facebook'] as const;
export type PlatformId = (typeof PLATFORMS)[number];
export const PlatformIdSchema = z.enum(PLATFORMS);

export const PLATFORM_PREFIX = { linkedin: 'li', facebook: 'fb' } as const satisfies Record<PlatformId, string>;

/** Human names, used in UI copy ("works with LinkedIn and Facebook"). */
export const PLATFORM_NAMES: Record<PlatformId, string> = { linkedin: 'LinkedIn', facebook: 'Facebook' };

/**
 * Local post key: platform prefix + the platform's own id, e.g. `li:urn:li:activity:123`, `li:ck:<key>`,
 * `fb:<fbid>`, or `li:h:<hash>` when the page shows no id. Never sent anywhere, not even hashed: a post that leaves the
 * device carries a batch-local ref (`PostForAI.ref`).
 */
export type PostKey = `${(typeof PLATFORM_PREFIX)[PlatformId]}:${string}`;

export function platformOfKey(key: string): PlatformId | undefined {
  const prefix = key.slice(0, key.indexOf(':'));
  return (Object.keys(PLATFORM_PREFIX) as PlatformId[]).find((p) => PLATFORM_PREFIX[p] === prefix);
}

export const AUTHOR_KINDS = ['person', 'page', 'group', 'unknown'] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

export const MEDIA_KINDS = ['none', 'image', 'video', 'reel', 'document', 'link', 'poll', 'event', 'other'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
