import { AIError } from '@unalgorithm/ai';
import { type Device, WEB_SEARCH_PROVIDERS, type WebSearchProviderId, webSearchName, webSearchOrigin } from '@unalgorithm/core';
import { createSearchProvider, type SearchProvider } from '@unalgorithm/research';
import { browser } from 'wxt/browser';
import type { BgError } from '../lib/messages.ts';
import { updateDevice } from '../lib/settings-store.ts';
import { getSecret, setSecret } from './idb.ts';

/**
 * The person's own web search key for an OpenAI-compatible source (F24, P3-45). The key is a secret in IndexedDB like an
 * AI key (`search:<provider>`); `device.webSearch` only names the provider. The host permission is asked for from the
 * Save click in Settings; the background only checks it.
 */

const MAX_KEY_LENGTH = 200;

const secretId = (p: WebSearchProviderId) => `search:${p}`;
const pattern = (p: WebSearchProviderId) => `${webSearchOrigin(p)}/*`;
const isProvider = (p: unknown): p is WebSearchProviderId => (WEB_SEARCH_PROVIDERS as readonly unknown[]).includes(p);

async function hasOrigin(p: WebSearchProviderId): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins: [pattern(p)] });
  } catch {
    return false;
  }
}

function searchError(err: unknown, p: WebSearchProviderId): BgError {
  const name = webSearchName(p);
  const code = err instanceof AIError ? err.code : 'unknown';
  if (code === 'not-available') return { code, message: `${name} didn't accept this key.` };
  if (code === 'rate-limit') return { code, message: `${name} is limiting searches right now. Try again in a minute.` };
  return { code, message: `Couldn't reach ${name}. Try again.` };
}

/** Tests the key with one fixed search (never post content, D47), then stores it in place of any other provider's. */
export async function saveSearchKey(provider: unknown, apiKey: unknown): Promise<{ ok: true } | { ok: false; error: BgError }> {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!isProvider(provider) || key.length < 1 || key.length > MAX_KEY_LENGTH) {
    return { ok: false, error: { code: 'bad-request', message: 'Enter the whole key.' } };
  }
  if (!(await hasOrigin(provider))) {
    const host = new URL(webSearchOrigin(provider)).hostname;
    return { ok: false, error: { code: 'host-permission', message: `UnAlgorithm needs permission to reach ${host}.` } };
  }
  try {
    await createSearchProvider({ provider, apiKey: key }).search('UnAlgorithm', { count: 1 });
  } catch (err) {
    return { ok: false, error: searchError(err, provider) };
  }
  await setSecret(secretId(provider), key);
  for (const other of WEB_SEARCH_PROVIDERS) if (other !== provider) await setSecret(secretId(other), undefined);
  await updateDevice((d) => {
    d.webSearch = { provider };
  });
  return { ok: true };
}

/** Removes the key and the setting, then gives up both hosts (best effort). The AI source and its key stay. */
export async function forgetSearchKey(): Promise<void> {
  for (const p of WEB_SEARCH_PROVIDERS) await setSecret(secretId(p), undefined);
  await updateDevice((d) => {
    d.webSearch = null;
  });
  await Promise.all(
    WEB_SEARCH_PROVIDERS.map(async (p) => {
      try {
        await browser.permissions.remove({ origins: [pattern(p)] });
      } catch {
        // Best effort: the key is already gone.
      }
    }),
  );
}

/** The search provider on this device's key, or null when none is set up (P3-46 runs on it). */
export async function deviceSearchProvider(device: Pick<Device, 'webSearch'>): Promise<SearchProvider | null> {
  if (!device.webSearch) return null;
  const { provider } = device.webSearch;
  const apiKey = await getSecret(secretId(provider));
  return apiKey ? createSearchProvider({ provider, apiKey }) : null;
}
