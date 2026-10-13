import type { InterestProfile, PostForAI } from '@unalgorithm/protocol';
import { serverPost } from './classify.ts';

/**
 * The canary (R22): a marker that rides in post text, link titles and the interest profile. Posts pass through the
 * server and nothing is kept, so it must never turn up in the server's log, its standard output, an error answer or a
 * database row. Only the model may receive it, and then only from posts a server may receive.
 */
export const CANARY = 'UA-CANARY-7f3c9e1b-DO-NOT-STORE';

/** In the friends-only post alone, so a test can tell whether that post reached the model. */
export const FRIENDS_ONLY = 'UA-FRIENDS-ONLY-4a61';

/** A shared link whose title carries the marker: the domain and title are all of a link that leaves the device. */
const CANARY_LINK = { domain: 'example.org', title: `Release notes ${CANARY}` };

/**
 * `n` posts a server may receive, half LinkedIn and half public Facebook, then one friends-only Facebook post (R23 keeps
 * it from any model), `n + 1` in all. Every text and link title carries the marker; refs are `pk_…`, as the extension
 * sends them.
 */
export async function canaryPosts(n: number): Promise<PostForAI[]> {
  const shared = Array.from({ length: n }, (_, i) =>
    serverPost(`canary-${i}`, `Quarterly update ${CANARY} about AI agents`, {
      link: CANARY_LINK,
      ...(i % 2 === 1 ? { platform: 'facebook', audience: 'public' } : {}),
    }),
  );
  const friendsOnly = serverPost('canary-friends', `Family news ${CANARY} ${FRIENDS_ONLY}`, {
    platform: 'facebook',
    audience: 'friends',
    link: CANARY_LINK,
  });
  return Promise.all([...shared, friendsOnly]);
}

/** An interest profile with the marker in `about` and in one interest. */
export function canaryProfile(): InterestProfile {
  return {
    v: 1,
    interests: ['automation', CANARY],
    lessOf: ['politics'],
    about: `I lead a small engineering team. ${CANARY}`,
    examples: [],
  };
}
