import {
  type Classification,
  FACTCHECK_TYPICAL_COST_MICROS,
  PERSPECTIVES_TYPICAL_COST_MICROS,
  serverMayReceive,
} from '@unalgorithm/protocol';
import { type AISourceConfig, offerPrice, type ServerJobTask, type ServerOffer, sourceCapabilities } from './ai-source.ts';
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

/** True when the post shares a link whose URL parses with an http: or https: protocol. */
function sharesWebLink(post: Pick<PostData, 'sharedLink'>): boolean {
  const url = post.sharedLink?.url;
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The one offer rule for "Other perspectives": Labs flag on, a source that can compare, a usable outlet registry
 * (`registryReady`, decided by the extension: P3-38's `perspectivesRegistry() !== null`), the classifier flagged the
 * post as news, the post shares an http(s) link, and the post is public (decision D38).
 */
export function perspectivesOffered(i: {
  device: Pick<Device, 'aiSource' | 'labs'>;
  post: Pick<PostData, 'platform' | 'audience' | 'sharedLink'>;
  classification: Pick<Classification, 'isNews'> | undefined;
  serverOffer?: ServerOffer | null;
  registryReady: boolean;
}): boolean {
  const { device, post, classification, serverOffer = null, registryReady } = i;
  return (
    device.labs.perspectives === true &&
    sourceCapabilities(device.aiSource, serverOffer).perspectives &&
    registryReady &&
    classification?.isNews === true &&
    sharesWebLink(post) &&
    serverMayReceive(post)
  );
}

const OWN_KEY_TYPICAL_MICROS: Record<ServerJobTask, number> = {
  factcheck: FACTCHECK_TYPICAL_COST_MICROS,
  perspectives: PERSPECTIVES_TYPICAL_COST_MICROS,
};

/**
 * The price shown before a job runs: "About $0.12" / "About $0.14 on your Anthropic account" for an own Anthropic key;
 * "Free on this server" or "About $0.27, at most $0.50" for a capable server source; null for a source that can't do
 * `task`. Copy is a draft (D21, D37).
 */
export function jobPriceLabel(task: ServerJobTask, cfg: AISourceConfig | null, offer: ServerOffer | null = null): string | null {
  if (!cfg || !sourceCapabilities(cfg, offer)[task]) return null;
  if (cfg.kind === 'anthropic') return `About ${formatPrice(OWN_KEY_TYPICAL_MICROS[task])} on your Anthropic account`;
  if (cfg.kind !== 'server' || !offer) return null;
  if (!offer.billing) return 'Free on this server';
  const price = offerPrice(task, offer);
  return price ? `About ${formatPrice(price.typicalMicros)}, at most ${formatPrice(price.maxMicros)}` : null;
}

/** The fact-check price label: `jobPriceLabel('factcheck', …)`. */
export const factcheckPriceLabel = (cfg: AISourceConfig | null, offer: ServerOffer | null = null): string | null =>
  jobPriceLabel('factcheck', cfg, offer);
