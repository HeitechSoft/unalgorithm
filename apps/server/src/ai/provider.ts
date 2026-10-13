/**
 * The AI client for a route, built from the same `packages/ai` adapters the extension uses: no second HTTP client. The
 * API key comes from the environment (`AI_API_KEY`), never from the route. Effort, thinking and structured output are
 * the adapters' and `classifyPosts`'s own choices.
 */
import { type AIClient, AIError, anthropicClient, memoryCapabilities, openaiCompatibleClient } from '@unalgorithm/ai';
import type { Config } from '../config.ts';
import { type AiRoute, validateRoute } from './routes.ts';

/** What each model and endpoint turned out to accept, learned once per process and shared by every client. */
const capabilities = memoryCapabilities();

export interface ProviderDeps {
  /** Default: the global `fetch`. Tests answer from a fake. */
  fetch?: typeof fetch;
}

/**
 * A client for `route`, which must pass the routing guard (`not-available` otherwise). Anthropic is always reached at
 * api.anthropic.com with `AI_API_KEY` alone: `anthropicClient` fixes the host and the credential and silences the SDK's
 * own logging, so `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_LOG` in the server's environment change
 * nothing, and `loadConfig` refuses `ANTHROPIC_CUSTOM_HEADERS`.
 */
export function clientForRoute(route: AiRoute, config: Config, deps: ProviderDeps = {}): AIClient {
  const check = validateRoute(route);
  if (!check.ok) throw new AIError('not-available', `The AI route is not allowed: ${check.reason}`);
  const fetchOption = deps.fetch ? { fetch: deps.fetch } : {};
  if (route.provider === 'anthropic') {
    // An empty key, never undefined: given no key, the SDK would read ANTHROPIC_API_KEY instead.
    return anthropicClient({ apiKey: config.ai.apiKey ?? '', capabilities, ...fetchOption });
  }
  // The guard admits only these two providers, and this one only with a base URL.
  return openaiCompatibleClient({ baseUrl: route.baseUrl ?? '', apiKey: config.ai.apiKey, capabilities, ...fetchOption });
}
