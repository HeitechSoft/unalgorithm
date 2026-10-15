import { type Classification, FACTCHECK_TYPICAL_COST_MICROS, serverMayReceive } from '@unalgorithm/protocol';
import { type AISourceConfig, sourceCapabilities } from './ai-source.ts';
import type { PostData } from './post.ts';
import type { Device } from './settings/schema.ts';
import { formatPrice } from './usage.ts';

/**
 * The one offer rule for "Check facts", shared by the in-feed button and the background: Labs → Fact-check is on, the
 * active source can fact-check, the classifier flagged the post as news or as making checkable claims, and the post is
 * public (a Facebook post that isn't public never gets it, on any source).
 */
export function factcheckOffered(i: {
  device: Pick<Device, 'aiSource' | 'labs'>;
  post: Pick<PostData, 'platform' | 'audience'>;
  classification: Pick<Classification, 'isNews' | 'hasCheckableClaims'> | undefined;
}): boolean {
  const { device, post, classification } = i;
  return (
    device.labs.factcheck === true &&
    sourceCapabilities(device.aiSource).factcheck &&
    !!classification &&
    (classification.isNews || classification.hasCheckableClaims) &&
    serverMayReceive(post)
  );
}

/** "About $0.12 on your Anthropic account" for an own Anthropic key; null for a source that can't fact-check. */
export function factcheckPriceLabel(cfg: AISourceConfig | null): string | null {
  if (cfg?.kind !== 'anthropic' || !sourceCapabilities(cfg).factcheck) return null;
  return `About ${formatPrice(FACTCHECK_TYPICAL_COST_MICROS)} on your Anthropic account`;
}
