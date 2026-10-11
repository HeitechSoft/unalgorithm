import { applyFeedback, createLock, decay } from '@unalgorithm/core';
import { type PostKey, uuidv7 } from '@unalgorithm/protocol';
import { learnedItem, votesItem } from '../lib/storage.ts';

const lock = createLock();
const MAX_VOTES = 500;

/** "More like this" / "Not for me" on a post: remember the vote and teach the topic weights. */
export async function recordVote(
  key: PostKey,
  verdict: 'more' | 'less' | null,
  topics: string[],
  summary: string | undefined,
): Promise<void> {
  await lock(async () => {
    const votes = { ...(await votesItem.getValue()) };
    delete votes[key];
    if (verdict) votes[key] = verdict;
    const keys = Object.keys(votes);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_VOTES))) delete votes[k];
    await votesItem.setValue(votes);
    if (!verdict) return;
    const learned = decay(await learnedItem.getValue());
    await learnedItem.setValue(
      applyFeedback(learned, {
        id: uuidv7(),
        at: Date.now(),
        verdict,
        topics,
        ...(summary ? { summary: summary.slice(0, 240) } : {}),
      }),
    );
  });
}
