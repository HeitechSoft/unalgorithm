import { type Classification, FACTCHECK_TYPICAL_COST_MICROS, serverMayReceive } from '@unalgorithm/protocol';
import { type AISourceConfig, type ServerOffer, sourceCapabilities } from './ai-source.ts';
import type { PostData } from './post.ts';
import type { Device } from './settings/schema.ts';
import { formatPrice } from './usage.ts';

/**
 * The one offer rule for "Check facts", shared by the in-feed button and the background: Labs → Fact-check is on, the
 * active source can fact-check, the classifier flagged the post as news or as making checkable claims, and the post is
 * public (a Facebook post that isn't public never gets it, on any source). `serverOffer` is what the signed-in server
 * offers (`local:serverOffer`); only a server source reads it.
 */
export function factcheckOffered(i: {
  device: Pick<Device, 'aiSource' | 'labs'>;
  post: Pick<PostData, 'platform' | 'audience'>;
  classification: Pick<Classification, 'isNews' | 'hasCheckableClaims'> | undefined;
  serverOffer?: ServerOffer | null;
}): boolean {
  const { device, post, classification, serverOffer = null } = i;
  return (
    device.labs.factcheck === true &&
    sourceCapabilities(device.aiSource, serverOffer).factcheck &&
    !!classification &&
    (classification.isNews || classification.hasCheckableClaims) &&
    serverMayReceive(post)
  );
}

/**
 * The price shown before a check runs: "About $0.12 on your Anthropic account" for an own Anthropic key; "Free on this
 * server" or "About $0.24, at most $0.40" for a capable server source; null for a source that can't fact-check.
 * Copy is a draft (D21).
 */
export function factcheckPriceLabel(cfg: AISourceConfig | null, offer: ServerOffer | null = null): string | null {
  if (!cfg || !sourceCapabilities(cfg, offer).factcheck) return null;
  if (cfg.kind === 'anthropic') return `About ${formatPrice(FACTCHECK_TYPICAL_COST_MICROS)} on your Anthropic account`;
  if (cfg.kind !== 'server' || !offer) return null;
  if (!offer.billing) return 'Free on this server';
  const price = offer.factcheckPrice;
  return price ? `About ${formatPrice(price.typicalMicros)}, at most ${formatPrice(price.maxMicros)}` : null;
}
