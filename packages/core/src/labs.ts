import {
  type Classification,
  FACTCHECK_TYPICAL_COST_MICROS,
  LEAN_BUCKETS,
  MAX_FACTCHECK_CLAIMS,
  OPENAI_FACTCHECK_TYPICAL_COST_MICROS,
  OPENAI_PERSPECTIVES_TYPICAL_COST_MICROS,
  PERSPECTIVES_TYPICAL_COST_MICROS,
  serverMayReceive,
} from '@unalgorithm/protocol';
import {
  type AISourceConfig,
  isLocalSource,
  offerPrice,
  type ServerJobTask,
  type ServerOffer,
  sourceCapabilities,
  type WebSearchKey,
  webSearchName,
} from './ai-source.ts';
import type { PostData } from './post.ts';
import type { Device } from './settings/schema.ts';
import { formatPrice } from './usage.ts';

/**
 * The one offer rule for "Check facts", shared by the in-feed button and the background: Settings → AI → Fact-check is
 * on, the active source can fact-check, the classifier flagged the post as news or as making checkable claims, and the
 * post is public (a Facebook post that isn't public never gets it, on any source). `serverOffer` is what the signed-in
 * server offers (`local:serverOffer`); only a server source reads it. `device.webSearch` only matters to an
 * OpenAI-compatible source.
 */
export function factcheckOffered(i: {
  device: Pick<Device, 'aiSource' | 'labs' | 'webSearch'>;
  post: Pick<PostData, 'platform' | 'audience'>;
  classification: Pick<Classification, 'isNews' | 'hasCheckableClaims'> | undefined;
  serverOffer?: ServerOffer | null;
}): boolean {
  const { device, post, classification, serverOffer = null } = i;
  return (
    device.labs.factcheck === true &&
    sourceCapabilities(device.aiSource, serverOffer, device.webSearch).factcheck &&
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
 * The one offer rule for UnEcho Chamber: its switch on (`labs.perspectives`), a source that can compare, a usable
 * outlet registry (`registryReady`, decided by the extension: P3-38's `perspectivesRegistry() !== null`), the
 * classifier flagged the post as news, the post shares an http(s) link, and the post is public (decision D38).
 */
export function perspectivesOffered(i: {
  device: Pick<Device, 'aiSource' | 'labs' | 'webSearch'>;
  post: Pick<PostData, 'platform' | 'audience' | 'sharedLink'>;
  classification: Pick<Classification, 'isNews'> | undefined;
  serverOffer?: ServerOffer | null;
  registryReady: boolean;
}): boolean {
  const { device, post, classification, serverOffer = null, registryReady } = i;
  return (
    device.labs.perspectives === true &&
    sourceCapabilities(device.aiSource, serverOffer, device.webSearch).perspectives &&
    registryReady &&
    classification?.isNews === true &&
    sharesWebLink(post) &&
    serverMayReceive(post)
  );
}

const OWN_KEY_TYPICAL_MICROS: Record<'anthropic' | 'openai', Record<ServerJobTask, number>> = {
  anthropic: { factcheck: FACTCHECK_TYPICAL_COST_MICROS, perspectives: PERSPECTIVES_TYPICAL_COST_MICROS },
  openai: { factcheck: OPENAI_FACTCHECK_TYPICAL_COST_MICROS, perspectives: OPENAI_PERSPECTIVES_TYPICAL_COST_MICROS },
};

/** Searches a job makes on the device's web search key, fixed by code: one per claim, one per lean bucket. */
const MAX_SEARCHES: Record<ServerJobTask, number> = {
  factcheck: MAX_FACTCHECK_CLAIMS,
  perspectives: LEAN_BUCKETS.length,
};

/**
 * The price shown before a job runs: "About $0.12 on your Anthropic account" / "About $0.09 on your OpenAI account" for
 * an own key; "Free on this computer, plus up to 3 searches on your Brave key" (or "Your AI provider's usual price, …")
 * for an OpenAI-compatible source with a web search key; "Free on this server" or "About $0.27, at most $0.50" for a
 * capable server source; null for a source that can't do `task`. Copy is a draft (D21, D37, D48).
 */
export function jobPriceLabel(
  task: ServerJobTask,
  cfg: AISourceConfig | null,
  offer: ServerOffer | null = null,
  webSearch: WebSearchKey | null = null,
): string | null {
  if (!cfg || !sourceCapabilities(cfg, offer, webSearch)[task]) return null;
  if (cfg.kind === 'anthropic') return `About ${formatPrice(OWN_KEY_TYPICAL_MICROS.anthropic[task])} on your Anthropic account`;
  if (cfg.kind === 'openai') return `About ${formatPrice(OWN_KEY_TYPICAL_MICROS.openai[task])} on your OpenAI account`;
  if (cfg.kind === 'openai-compatible' && webSearch) {
    const ai = isLocalSource(cfg) ? 'Free on this computer' : "Your AI provider's usual price";
    return `${ai}, plus up to ${MAX_SEARCHES[task]} searches on your ${webSearchName(webSearch.provider)} key`;
  }
  if (cfg.kind !== 'server' || !offer) return null;
  if (!offer.billing) return 'Free on this server';
  const price = offerPrice(task, offer);
  return price ? `About ${formatPrice(price.typicalMicros)}, at most ${formatPrice(price.maxMicros)}` : null;
}

/**
 * The line under a finished check (decision D72, draft wording): what it cost on the person's own key, or what their
 * server charged. Null when nothing is known (an unpriced model, a free server). The price shown first
 * (`jobPriceLabel`) cannot know whether the claim cache will answer; this line shows what the check actually cost.
 */
export function checkCostLine(e: { costMicros?: number | undefined; chargedMicros?: number | undefined }): string | null {
  if (e.chargedMicros !== undefined) return `Charged ${formatPrice(e.chargedMicros)} to your balance.`;
  if (e.costMicros !== undefined) return `This check cost about ${formatPrice(e.costMicros)} on your own key.`;
  return null;
}

/** The fact-check price label: `jobPriceLabel('factcheck', …)`. */
export const factcheckPriceLabel = (
  cfg: AISourceConfig | null,
  offer: ServerOffer | null = null,
  webSearch: WebSearchKey | null = null,
): string | null => jobPriceLabel('factcheck', cfg, offer, webSearch);
