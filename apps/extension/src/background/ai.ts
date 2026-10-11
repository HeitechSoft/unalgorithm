import {
  type AIClient,
  AIError,
  ANTHROPIC_DEFAULT_MODEL,
  anthropicClient,
  type Capabilities,
  type CapabilityStore,
  COMPAT_PREFERENCES,
  COMPAT_PRESET_INFO,
  classifyPosts,
  describeError,
  isRetryable,
  modelLabel,
  OPENAI_PREFERENCES,
  openaiClient,
  openaiCompatibleClient,
  originPattern,
  pickModel,
} from '@unalgorithm/ai';
import { type OnDeviceAvailability, onDeviceAvailability, onDeviceClient } from '@unalgorithm/ai/chrome-builtin';
import {
  type AISourceConfig,
  buildInterestProfile,
  classificationCacheKey,
  createLimiter,
  createLock,
  dayCostMicros,
  dayUsage,
  defaultSettings,
  inputHash,
  isLocalSource,
  PROMPT_VERSION,
  profileHash,
  recordUsage,
  SOURCE_LIMITS,
  sourceId,
} from '@unalgorithm/core';
import { BLOCKING_AI_ERRORS, type PostForAI, PostForAISchema } from '@unalgorithm/protocol';
import { browser } from 'wxt/browser';
import { storage } from 'wxt/utils/storage';
import type { AiStatus, BgError, BgResponses, ClassifyItem, ClassifyItemResult, TestSourceResult } from '../lib/messages.ts';
import { updateDevice } from '../lib/settings-store.ts';
import { learnedItem, ORIGIN_RULE_ID, readDevice, readSettings, usageItem } from '../lib/storage.ts';
import { clearCache, getCached, getSecret, putCached, setSecret } from './idb.ts';

// ---------- capability learning, persisted across service-worker restarts ----------

const capabilitiesItem = storage.defineItem<Record<string, Capabilities>>('local:aiCapabilities', { fallback: {} });
let capCache: Record<string, Capabilities> | undefined;
const capabilities: CapabilityStore = {
  get: (k) => capCache?.[k],
  set: (k, v) => {
    capCache = { ...capCache, [k]: v };
    void capabilitiesItem.setValue(capCache);
  },
};
async function loadCapabilities(): Promise<void> {
  capCache ??= await capabilitiesItem.getValue();
}

// ---------- sources ----------

export function sourceLabel(cfg: AISourceConfig | null): string {
  if (!cfg) return 'Off';
  switch (cfg.kind) {
    case 'on-device':
      return 'On this device';
    case 'anthropic':
      return 'Claude (your key)';
    case 'openai':
      return 'OpenAI (your key)';
    case 'openai-compatible':
      return COMPAT_PRESET_INFO[cfg.preset].label;
    case 'server':
      return 'UnAlgorithm Cloud';
  }
}

function providerName(cfg: AISourceConfig): string {
  if (cfg.kind === 'anthropic') return 'Anthropic';
  if (cfg.kind === 'openai') return 'OpenAI';
  if (cfg.kind === 'openai-compatible') return COMPAT_PRESET_INFO[cfg.preset].label;
  if (cfg.kind === 'on-device') return 'Chrome';
  return 'UnAlgorithm Cloud';
}

/** The host permission a source needs, as a match pattern (null when it needs none). */
export function sourcePermission(cfg: AISourceConfig): string | null {
  switch (cfg.kind) {
    case 'anthropic':
      return 'https://api.anthropic.com/*';
    case 'openai':
      return 'https://api.openai.com/*';
    case 'openai-compatible':
      return originPattern(cfg.baseUrl);
    default:
      return null;
  }
}

let onDevice: AIClient | undefined;

async function clientFor(cfg: AISourceConfig, apiKey?: string): Promise<AIClient> {
  await loadCapabilities();
  const key = apiKey ?? (await getSecret(sourceId(cfg)));
  switch (cfg.kind) {
    case 'on-device':
      onDevice ??= onDeviceClient();
      return onDevice;
    case 'anthropic':
      if (!key) throw new AIError('no-key', 'Add your Anthropic API key.');
      return anthropicClient({ apiKey: key, capabilities });
    case 'openai':
      if (!key) throw new AIError('no-key', 'Add your OpenAI API key.');
      return openaiClient({ apiKey: key, capabilities });
    case 'openai-compatible':
      if (cfg.auth === 'bearer' && !key) throw new AIError('no-key', 'Add the API key or token for this server.');
      return openaiCompatibleClient({
        baseUrl: cfg.baseUrl,
        ...(cfg.auth === 'bearer' && key ? { apiKey: key } : {}),
        capabilities,
        ...(cfg.preset === 'openrouter'
          ? { extraHeaders: { 'HTTP-Referer': 'https://github.com/HeitechSoft/unalgorithm', 'X-Title': 'UnAlgorithm' } }
          : {}),
      });
    case 'server':
      throw new AIError('not-available', 'UnAlgorithm Cloud is coming soon.');
  }
}

function modelFor(cfg: AISourceConfig): string {
  if (cfg.kind === 'on-device') return 'chrome-built-in';
  if (cfg.kind === 'server') return 'server';
  if (cfg.model) return cfg.model;
  if (cfg.kind === 'anthropic') return ANTHROPIC_DEFAULT_MODEL;
  throw new AIError('no-model', 'Choose a model in Settings → AI.');
}

async function hasPermission(cfg: AISourceConfig): Promise<boolean> {
  const pattern = sourcePermission(cfg);
  if (!pattern) return true;
  try {
    return await browser.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

// ---------- classification ----------

const usageLock = createLock();
const limiters = new Map<string, ReturnType<typeof createLimiter>>();

function toBgError(e: AIError, cfg: AISourceConfig): BgError {
  return { code: e.code, message: describeError(e.code, providerName(cfg)) };
}

/**
 * Classify posts with the chosen source: cache first, then the daily cap (paid sources only), then the AI.
 * Rules-only (no source) never touches the network.
 */
export async function classifyItems(items: ClassifyItem[]): Promise<BgResponses['classify']> {
  const [device, settings, learned] = await Promise.all([readDevice(), readSettings(), learnedItem.getValue()]);
  const cfg = device.aiSource;
  if (!cfg) return { results: items.map((i) => ({ key: i.key, status: 'skipped', reason: 'ai-off' })) };

  const fail = (e: AIError): BgResponses['classify'] => ({
    results: items.map((i) => ({
      key: i.key,
      status: 'failed',
      code: e.code,
      message: describeError(e.code, providerName(cfg)),
      retryable: isRetryable(e.code),
    })),
    ...(BLOCKING_AI_ERRORS.has(e.code) ? { pause: toBgError(e, cfg) } : {}),
  });

  let model: string;
  let client: AIClient;
  try {
    if (!(await hasPermission(cfg))) throw new AIError('host-permission', 'Missing permission for the AI server.');
    model = modelFor(cfg);
    client = await clientFor(cfg);
  } catch (err) {
    return fail(err instanceof AIError ? err : new AIError('unknown', String(err)));
  }

  const sid = sourceId(cfg);
  const limits = SOURCE_LIMITS[cfg.kind];
  const profile = buildInterestProfile(settings, learned);
  const pHash = profileHash(profile);
  const results: ClassifyItemResult[] = [];
  const prepared = [];
  for (const it of items) {
    // Only the fields in PostForAISchema survive (zod strips anything else), whatever the content script sent.
    const raw = String(it.input?.text ?? '');
    const cut = raw.length > limits.maxPostChars;
    const parsed = PostForAISchema.safeParse({
      ...it.input,
      ref: 'x',
      text: cut ? `${raw.slice(0, limits.maxPostChars - 1).trimEnd()}…` : raw,
      textComplete: Boolean(it.input?.textComplete) && !cut,
    });
    if (!parsed.success) {
      results.push({
        key: it.key,
        status: 'failed',
        code: 'bad-request',
        message: 'This post could not be read.',
        retryable: false,
      });
      continue;
    }
    const input: PostForAI = parsed.data;
    const key = classificationCacheKey({
      postKey: it.key,
      inputHash: inputHash(input),
      profileHash: pHash,
      sourceId: sid,
      model,
      promptVersion: PROMPT_VERSION,
    });
    prepared.push({ item: it, input, cacheKey: key });
  }

  const cached = await getCached(prepared.map((p) => p.cacheKey));
  let misses = prepared.filter((p) => {
    const hit = cached.get(p.cacheKey);
    if (hit) results.push({ key: p.item.key, status: 'ok', classification: hit.classification, model: hit.model, cached: true });
    return !hit;
  });
  if (!misses.length) return { results };

  let pause: BgError | undefined;
  if (!isLocalSource(cfg)) {
    const used = dayUsage(await usageItem.getValue()).posts;
    const remaining = Math.max(0, settings.ai.dailyCap - used);
    for (const p of misses.slice(remaining)) results.push({ key: p.item.key, status: 'skipped', reason: 'cap-reached' });
    if (remaining < misses.length) pause = { code: 'cap-reached', message: describeError('cap-reached') };
    misses = misses.slice(0, remaining);
  }

  let limit = limiters.get(sid);
  if (!limit) {
    limit = createLimiter(limits.concurrency);
    limiters.set(sid, limit);
  }
  const groups: (typeof misses)[] = [];
  for (let i = 0; i < misses.length; i += limits.batch) groups.push(misses.slice(i, i + limits.batch));

  await Promise.all(
    groups.map((group) =>
      (limit as ReturnType<typeof createLimiter>)(async () => {
        const posts = group.map((p, i) => ({ ...p.input, ref: `p${i + 1}` }));
        const outcome = await classifyPosts(client, posts, {
          model,
          profile,
          compact: cfg.kind === 'on-device',
          timeoutMs: limits.timeoutMs,
        });
        const fresh = [];
        let ok = 0;
        for (const [i, p] of group.entries()) {
          const r = outcome.byRef.get(`p${i + 1}`);
          if (r?.ok) {
            ok++;
            results.push({
              key: p.item.key,
              status: 'ok',
              classification: r.classification,
              model: outcome.model,
              cached: false,
            });
            fresh.push({
              key: p.cacheKey,
              postKey: p.item.key,
              classification: r.classification,
              model: outcome.model,
              partialText: !p.input.textComplete,
              at: Date.now(),
            });
          } else {
            const e = r?.error ?? new AIError('unknown', 'No answer for this post.');
            if (e.code === 'refusal') results.push({ key: p.item.key, status: 'skipped', reason: 'declined' });
            else
              results.push({
                key: p.item.key,
                status: 'failed',
                code: e.code,
                message: describeError(e.code, providerName(cfg)),
                retryable: isRetryable(e.code),
              });
            if (BLOCKING_AI_ERRORS.has(e.code) && !pause) pause = toBgError(e, cfg);
          }
        }
        await putCached(fresh).catch(() => undefined);
        await usageLock(async () => {
          const ledger = await usageItem.getValue();
          await usageItem.setValue(
            recordUsage(ledger, {
              model: outcome.model,
              usage: outcome.usage,
              posts: isLocalSource(cfg) ? 0 : ok,
              failed: outcome.failedCalls > 0,
            }),
          );
        });
      }),
    ),
  );
  return { results, ...(pause ? { pause } : {}) };
}

// ---------- setup ----------

const PROBE: PostForAI = {
  ref: 'p1',
  platform: 'linkedin',
  text: 'We cut onboarding paperwork from three days to one by moving our forms online. What should we automate next?',
  textComplete: true,
  authorKind: 'person',
  isReshare: false,
  media: 'none',
};

/**
 * Check a source end to end before saving it: permission, key, model list, and one real structured answer.
 * Picks a sensible default model so people choose a provider, not a model.
 */
export async function testSource(cfg: AISourceConfig, apiKey?: string): Promise<TestSourceResult> {
  const started = Date.now();
  try {
    if (!(await hasPermission(cfg))) throw new AIError('host-permission', 'Missing permission.');
    if (cfg.kind === 'on-device') {
      const a = await onDeviceAvailability();
      if (a !== 'available') throw new AIError('not-available', `On-device AI is ${a}.`);
    }
    const client = await clientFor(cfg, apiKey);
    let models: string[] = [];
    if (cfg.kind !== 'on-device') {
      try {
        models = (await client.listModels()).map((m) => m.id);
      } catch (err) {
        // Some servers don't list models; an explicit model still works.
        if (err instanceof AIError && (err.code === 'auth' || err.code === 'origin-blocked' || err.code === 'network')) throw err;
      }
    }
    const model =
      cfg.kind === 'on-device'
        ? 'chrome-built-in'
        : cfg.kind === 'anthropic'
          ? (cfg.model ?? ANTHROPIC_DEFAULT_MODEL)
          : cfg.kind === 'openai'
            ? (cfg.model ?? pickModel(models, OPENAI_PREFERENCES))
            : cfg.kind === 'openai-compatible'
              ? (cfg.model ?? pickModel(models, COMPAT_PREFERENCES[cfg.preset] ?? []))
              : undefined;
    if (!model) throw new AIError('no-model', 'This server lists no models.');
    const out = await classifyPosts(client, [PROBE], {
      model,
      profile: buildInterestProfile(defaultSettings()),
      compact: cfg.kind === 'on-device',
      timeoutMs: SOURCE_LIMITS[cfg.kind].timeoutMs,
    });
    const r = out.byRef.get('p1');
    if (!r?.ok) throw r?.error ?? new AIError('unknown', 'No answer.');
    return { ok: true, model, mode: out.mode ?? 'json-schema', latencyMs: Date.now() - started, models };
  } catch (err) {
    const e = err instanceof AIError ? err : new AIError('unknown', String(err));
    return { ok: false, error: { code: e.code, message: describeError(e.code, providerName(cfg)) } };
  }
}

/** The models a configured source offers, using its saved key. Nothing is classified. */
export async function listSourceModels(cfg: AISourceConfig): Promise<BgResponses['listModels']> {
  try {
    if (!(await hasPermission(cfg))) throw new AIError('host-permission', 'Missing permission.');
    const client = await clientFor(cfg);
    try {
      return { ok: true, models: (await client.listModels()).map((m) => m.id) };
    } catch (err) {
      // A server without a usable model list still works with an explicit model; anything else is a real error.
      const unsupported = ['unsupported', 'not-available', 'model-not-found', 'bad-request', 'unknown'];
      if (err instanceof AIError && !unsupported.includes(err.code)) throw err;
      return { ok: true, models: [] };
    }
  } catch (err) {
    const e = err instanceof AIError ? err : new AIError('unknown', String(err));
    return { ok: false, error: { code: e.code, message: describeError(e.code, providerName(cfg)) } };
  }
}

export async function saveSource(cfg: AISourceConfig | null, apiKey?: string): Promise<BgResponses['saveSource']> {
  if (cfg && apiKey) await setSecret(sourceId(cfg), apiKey.trim());
  await updateDevice((d) => {
    d.aiSource = cfg;
  });
  await dropStaleOriginRule(cfg);
  return { ok: true };
}

/** Removes the local-server Origin rule (ADR 0004) once the AI source no longer points at that server. */
async function dropStaleOriginRule(cfg: AISourceConfig | null): Promise<void> {
  try {
    const dnr = browser.declarativeNetRequest;
    if (!dnr) return;
    const rule = (await dnr.getDynamicRules()).find((r) => r.id === ORIGIN_RULE_ID);
    if (!rule) return;
    let host: string | null = null;
    if (cfg?.kind === 'openai-compatible') {
      try {
        host = new URL(cfg.baseUrl).host;
      } catch {
        host = null;
      }
    }
    if (!host || !rule.condition.urlFilter?.includes(`//${host}/`)) {
      await dnr.updateDynamicRules({ removeRuleIds: [ORIGIN_RULE_ID] });
    }
  } catch {
    // The optional permission was never granted, or the API is unavailable: nothing to remove.
  }
}

export async function forgetKey(cfg: AISourceConfig): Promise<void> {
  await setSecret(sourceId(cfg), undefined);
}

export async function aiStatus(): Promise<AiStatus> {
  const [device, settings, ledger] = await Promise.all([readDevice(), readSettings(), usageItem.getValue()]);
  const cfg = device.aiSource;
  const day = dayUsage(ledger);
  let model: string | undefined;
  try {
    model = cfg ? modelLabel(modelFor(cfg)) : undefined;
  } catch {
    model = undefined;
  }
  const cost = dayCostMicros(day);
  return {
    configured: !!cfg,
    kind: cfg?.kind ?? null,
    label: sourceLabel(cfg),
    ...(model ? { model } : {}),
    state: cfg ? 'ready' : 'off',
    postsToday: day.posts,
    dailyCap: settings.ai.dailyCap,
    capApplies: !!cfg && !isLocalSource(cfg),
    ...(cost !== undefined ? { costTodayMicros: cost } : {}),
  };
}

export async function onDeviceStatus(): Promise<OnDeviceAvailability> {
  return onDeviceAvailability();
}

export async function clearAiData(): Promise<void> {
  await clearCache();
}

/** Forget what was learned about AI servers (their addresses and supported output modes). */
export async function clearAiCapabilities(): Promise<void> {
  capCache = {};
  await capabilitiesItem.removeValue();
}
