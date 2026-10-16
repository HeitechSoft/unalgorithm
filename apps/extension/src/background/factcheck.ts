import { AIError, describeError } from '@unalgorithm/ai';
import {
  type AISourceConfig,
  createLock,
  type Device,
  SOURCE_LIMITS,
  serverOfferFrom,
  sourceCapabilities,
  type WebSearchKey,
  webSearchName,
  webSearchOrigin,
} from '@unalgorithm/core';
import type { Registry } from '@unalgorithm/outlets';
import {
  type AIErrorCode,
  FEATURE_NAMES,
  type PerspectivesJobRequest,
  PerspectivesJobRequestSchema,
  type PostForAI,
  type PostKey,
  type SharedLink,
  SharedLinkSchema,
  serverMayReceive,
} from '@unalgorithm/protocol';
import {
  canonicalLink,
  factcheckDepsForMode,
  type OwnKeyMode,
  perspectivesDepsForMode,
  runFactcheck,
  runPerspectives,
  WebSearchFailure,
} from '@unalgorithm/research';
import { browser } from 'wxt/browser';
import type { BgError, BgResponses } from '../lib/messages.ts';
import { leansMatchRegistry, perspectivesRegistry } from '../lib/outlets.ts';
import { type FactcheckEntry, factcheckItem, readDevice } from '../lib/storage.ts';
import { clientFor, hasPermission, parsePostInput, providerName, recordSpend } from './ai.ts';
import { deviceClaimCache } from './claim-cache.ts';
import { runFactcheckViaServer, runPerspectivesViaServer } from './factcheck-server.ts';
import { deviceSearchProvider } from './search-key.ts';
import { serverAccountItem } from './server-auth.ts';

/** Checks kept per tab, newest first. */
export const FACTCHECK_KEEP = 5;
const LABEL_CHARS = 80;

/**
 * Tabs with a check running in this worker. Checked and added in one synchronous step, so two quick clicks can't both
 * run and pay; a worker that dies mid-check takes the set with it, so its stored `running` entry never blocks the tab.
 */
const inFlight = new Set<number>();
const entriesLock = createLock();
/** The server check running for each tab: aborting it cancels the job on the server. */
const running = new Map<number, AbortController>();

type FactcheckResponse = BgResponses['factcheck'];
type PerspectivesResponse = BgResponses['perspectives'];
/** A tab's task: a fact-check, or an UnEcho Chamber comparison. */
type Task = 'factcheck' | 'perspectives';
type Refusal = { ok: false; error: BgError };
/** `costMicros`: an own-key run's cost; `chargedMicros`: what the server charged. */
type TaskAnswer<R> = { ok: true; result: R; costMicros?: number; chargedMicros?: number } | Refusal;
/** A source whose provider the browser calls directly, on the person's own key. */
type OwnKey = Extract<AISourceConfig, { kind: 'anthropic' | 'openai' | 'openai-compatible' }>;

const refuse = (code: AIErrorCode, message: string): Refusal => ({ ok: false, error: { code, message } });

const BUSY: Record<Task, string> = {
  factcheck: 'A check is already running on this page.',
  perspectives: 'A check or comparison is already running on this page.',
};

const needs = (task: Task) =>
  `${FEATURE_NAMES[task]} needs your own Anthropic or OpenAI key, an AI server with a web search key, or a server that offers it.`;
const NEEDS: Record<Task, string> = { factcheck: needs('factcheck'), perspectives: needs('perspectives') };

/**
 * Opens the side panel for a tab. Called before any `await` in the handler, so Chrome still sees the click's user
 * gesture; resolves false when Chrome refuses (or has no side panel).
 */
export function openFactcheckPanel(tabId: number): Promise<boolean> {
  try {
    return browser.sidePanel.open({ tabId }).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/** Update the tab's entries under the lock. `change` returns null to write nothing. */
async function updateEntries(tabId: number, change: (entries: FactcheckEntry[]) => FactcheckEntry[] | null): Promise<void> {
  await entriesLock(async () => {
    const item = factcheckItem(tabId);
    const next = change((await item.getValue()).entries);
    if (next) await item.setValue({ entries: next.slice(0, FACTCHECK_KEEP) });
  });
}

/**
 * Remove a closed tab's checks, and stop a server check still running for it. Under the same lock as every write, so a check that ends after the tab closed can't
 * write its entry (and the post's first words) back.
 */
export function forgetFactchecks(tabId: number): Promise<void> {
  // A server check is cancelled on the server too (`runFactcheckViaServer` sends the cancel).
  running.get(tabId)?.abort();
  return entriesLock(() => factcheckItem(tabId).removeValue());
}

/** The own-key source when it can run `task`: an OpenAI-compatible one only with this device's web search key. */
function capableOwnKey(cfg: AISourceConfig | null, device: Device, task: Task): OwnKey | null {
  if (!cfg || cfg.kind === 'server' || cfg.kind === 'on-device') return null;
  return sourceCapabilities(cfg, null, device.webSearch)[task] ? cfg : null;
}

/** The mode for an own-key source, or the refusal that stops the run before anything is sent. */
async function ownKeyMode(cfg: OwnKey, device: Device): Promise<OwnKeyMode | Refusal> {
  if (cfg.kind !== 'openai-compatible') return { kind: cfg.kind };
  if (!cfg.model) return refuse('no-model', 'Choose a model in Settings → AI.');
  const search = await deviceSearchProvider(device);
  if (!search) return refuse('no-key', 'Add a web search key in Settings → Labs.');
  return { kind: cfg.kind, model: cfg.model, search };
}

const isRefusal = (m: OwnKeyMode | Refusal): m is Refusal => 'ok' in m;

/**
 * The text a failed own-key run shows: a search failure names the web search key's provider, everything else the AI's;
 * task wording where the classify text `describeError` gives would be wrong.
 */
function ownKeyError(err: unknown, cfg: OwnKey, task: Task): BgError {
  const e = err instanceof AIError ? err : new AIError('unknown', String(err));
  if (e instanceof WebSearchFailure) {
    const name = e.provider === 'searxng' ? 'the search service' : webSearchName(e.provider);
    if (e.code === 'not-available')
      return { code: e.code, message: `Your ${name} key was refused. Check it in Settings → Labs.` };
    if (e.code === 'rate-limit')
      return { code: e.code, message: `${name} is limiting searches right now. Try again in a minute.` };
    return { code: e.code, message: `Couldn't reach ${name}.` };
  }
  if (e.code === 'unsupported' && cfg.kind === 'anthropic')
    return { code: e.code, message: "Web search isn't turned on for this Anthropic account." };
  if (e.code === 'unsupported' && cfg.kind === 'openai')
    return { code: e.code, message: "Web search isn't available for this OpenAI key or model." };
  if (e.code === 'refusal')
    return {
      code: e.code,
      message: task === 'factcheck' ? 'The AI declined to check this post.' : 'The AI declined to compare this link.',
    };
  if (e.code === 'bad-request' && task === 'perspectives') return { code: e.code, message: NOT_COMPARABLE };
  return { code: e.code, message: describeError(e.code, providerName(cfg)) };
}

/**
 * Fact-check one post for a feed tab, on the person's own key (Anthropic, OpenAI, or an OpenAI-compatible server with
 * this device's web search key) or on their UnAlgorithm server. Every gate is checked again here, and each refusal
 * returns before anything is sent. The result is kept in the tab's session storage, where the side panel reads it.
 */
export async function runFactcheckForTab(tabId: number, key: PostKey, input: Omit<PostForAI, 'ref'>): Promise<FactcheckResponse> {
  const device = await readDevice();
  if (!device.labs.factcheck) return refuse('not-available', 'Turn on Fact-check in Settings → Labs.');
  const cfg = device.aiSource;
  if (cfg?.kind === 'server') return runOnServer(tabId, key, input, cfg);
  const own = capableOwnKey(cfg, device, 'factcheck');
  if (!own) return refuse('unsupported', NEEDS.factcheck);
  const post = parsePostInput(input, SOURCE_LIMITS[own.kind].maxPostChars);
  if (!post) return refuse('bad-request', 'This post could not be read.');
  // Only public posts, own keys too (decision D2).
  if (!serverMayReceive(post)) return refuse('not-available', ONLY_PUBLIC);
  const mode = await ownKeyMode(own, device);
  if (isRefusal(mode)) return mode;
  const label = post.text.slice(0, LABEL_CHARS);
  return track(tabId, key, label, 'factcheck', own, () => runOwnKey(post, own, mode), device.webSearch);
}

const ONLY_PUBLIC = 'Fact-check works only on public posts.';

/** The server's own check (P3-21): the server meters, so a done entry has its `chargedMicros`, never `costMicros`. */
async function runOnServer(
  tabId: number,
  key: PostKey,
  input: Omit<PostForAI, 'ref'>,
  cfg: Extract<AISourceConfig, { kind: 'server' }>,
): Promise<FactcheckResponse> {
  const account = await serverAccountItem.getValue();
  if (!account || !sourceCapabilities(cfg, serverOfferFrom(account)).factcheck)
    return refuse('unsupported', "This server doesn't offer fact-check.");
  const post = parsePostInput(input, SOURCE_LIMITS.server.maxPostChars);
  if (!post) return refuse('bad-request', 'This post could not be read.');
  if (!serverMayReceive(post)) return refuse('not-available', ONLY_PUBLIC);
  return track(tabId, key, post.text.slice(0, LABEL_CHARS), 'factcheck', cfg, () =>
    cancelOnTabClose(tabId, (signal) => runFactcheckViaServer(account, { ...post, ref: 'p1' }, { signal })),
  );
}

/** Runs a server job on a signal that closing the tab fires (`forgetFactchecks`), so the job is cancelled. */
async function cancelOnTabClose<A>(tabId: number, run: (signal: AbortSignal) => Promise<A>): Promise<A> {
  const controller = new AbortController();
  running.set(tabId, controller);
  try {
    return await run(controller.signal);
  } finally {
    if (running.get(tabId) === controller) running.delete(tabId);
  }
}

/**
 * The check on the person's key, with the mode's deps (P3-43). Every call's spend is in the ledger with `posts: 0` (no
 * daily post cap); `costMicros` only when the models are priced (an OpenAI-compatible model has no card).
 */
async function runOwnKey(post: PostForAI, cfg: OwnKey, mode: OwnKeyMode): Promise<FactcheckResponse> {
  // Every call's spend is in the ledger before the answer goes back, so the popup's cost today includes it.
  const spends: Promise<void>[] = [];
  try {
    const client = await clientFor(cfg);
    // This device's own claim cache (P3-60); the pipeline uses it for public posts only.
    const deps = { ...factcheckDepsForMode(client, mode), claimCache: deviceClaimCache() };
    const run = await runFactcheck({ ...post, ref: 'p1' }, deps, {
      onUsage: (u) => spends.push(recordSpend(u.model, u.usage, { posts: 0, failed: u.failed })),
    });
    await Promise.all(spends);
    return { ok: true, result: run.result, ...(run.costMicros !== undefined ? { costMicros: run.costMicros } : {}) };
  } catch (err) {
    await Promise.allSettled(spends);
    return { ok: false, error: ownKeyError(err, cfg, 'factcheck') };
  }
}

/**
 * The refusal when a host permission the run needs is missing: the source's own and, for an OpenAI-compatible source,
 * its web search service's. Only checked here: both are asked for from a click in Settings.
 */
async function missingPermission(cfg: AISourceConfig, webSearch: WebSearchKey | null): Promise<Refusal | null> {
  if (!(await hasPermission(cfg))) return refuse('host-permission', describeError('host-permission', providerName(cfg)));
  if (cfg.kind !== 'openai-compatible' || !webSearch) return null;
  let granted = false;
  try {
    granted = await browser.permissions.contains({ origins: [`${webSearchOrigin(webSearch.provider)}/*`] });
  } catch {
    granted = false;
  }
  if (granted) return null;
  const name = webSearchName(webSearch.provider);
  return refuse(
    'host-permission',
    `UnAlgorithm needs permission to reach ${name}. Save your web search key again in Settings → Labs.`,
  );
}

/**
 * One check or comparison per tab: the host permissions, then a `running` entry, then `run`, whose answer settles the
 * entry. Nothing is settled when the tab closed meanwhile (its entries are gone): the item stays removed.
 */
async function track<A extends TaskAnswer<unknown>>(
  tabId: number,
  key: PostKey,
  label: string,
  task: Task,
  cfg: AISourceConfig,
  run: () => Promise<A>,
  webSearch: WebSearchKey | null = null,
): Promise<A | Refusal> {
  if (inFlight.has(tabId)) return refuse('rate-limit', BUSY[task]);
  inFlight.add(tabId);
  try {
    const denied = await missingPermission(cfg, webSearch);
    if (denied) return denied;

    const startedAt = Date.now();
    const mine = (e: FactcheckEntry) => e.startedAt === startedAt && e.key === key && e.status === 'running';
    const settle = (patch: Partial<FactcheckEntry>) =>
      updateEntries(tabId, (entries) => (entries.some(mine) ? entries.map((e) => (mine(e) ? { ...e, ...patch } : e)) : null));
    // Another `running` entry can only be left by a worker that died mid-check: this tab is in `inFlight` now.
    const stale: Partial<FactcheckEntry> = { status: 'failed', error: { code: 'timeout', message: describeError('timeout') } };
    await updateEntries(tabId, (entries) => [
      { key, ...(task === 'perspectives' ? { task } : {}), label, startedAt, status: 'running' },
      ...entries.map((e) => (e.status === 'running' ? { ...e, ...stale } : e)),
    ]);

    const answer = await run();
    if (answer.ok) {
      const cost = {
        ...(answer.costMicros !== undefined ? { costMicros: answer.costMicros } : {}),
        ...(answer.chargedMicros !== undefined ? { chargedMicros: answer.chargedMicros } : {}),
      };
      const result = task === 'perspectives' ? { perspectives: answer.result } : { result: answer.result };
      await settle({ status: 'done', ...(result as Partial<FactcheckEntry>), ...cost });
    } else {
      await settle({ status: 'failed', error: answer.error });
    }
    return answer;
  } finally {
    inFlight.delete(tabId);
  }
}

/** Only the link, the platform and (Facebook) the audience: nothing else from the post reaches here. */
export interface PerspectivesTabRequest {
  link: SharedLink;
  platform: PerspectivesJobRequest['platform'];
  audience?: PerspectivesJobRequest['audience'] | undefined;
}

const NOT_COMPARABLE = "This link can't be compared.";
const PLACE = PerspectivesJobRequestSchema.pick({ platform: true, audience: true });
const LEANS_MISMATCH = "This server's outlet list doesn't match this version of UnAlgorithm, so the comparison isn't shown.";

/**
 * UnEcho Chamber for one shared link in a feed tab, on the person's own key (as fact-check) or on their
 * UnAlgorithm server. Every gate is checked again here, and each refusal returns before anything is sent. Only the link
 * leaves the browser, canonicalised first (tracking and per-click ids removed, decision D35); a result is kept only when
 * every lean in it is this build's own registry's (`leansMatchRegistry`).
 */
export async function runPerspectivesForTab(
  tabId: number,
  key: PostKey,
  req: PerspectivesTabRequest,
): Promise<PerspectivesResponse> {
  const device = await readDevice();
  if (!device.labs.perspectives) return refuse('not-available', `Turn on ${FEATURE_NAMES.perspectives} in Settings → Labs.`);
  const registry = perspectivesRegistry();
  if (!registry) return refuse('not-available', `${FEATURE_NAMES.perspectives} isn't available yet.`);
  const parsed = SharedLinkSchema.safeParse(req.link);
  const url = parsed.success ? canonicalLink(parsed.data.url) : null;
  if (!parsed.success || !url) return refuse('bad-request', NOT_COMPARABLE);
  const title = parsed.data.title;
  const link: SharedLink = { url, ...(title !== undefined ? { title } : {}) };
  // Only public posts, own keys too (decision D2). Platform and audience are the protocol's own values first: an unknown
  // platform would pass `serverMayReceive` as public, and would leave the browser as sent.
  const place = PLACE.safeParse({ platform: req.platform, audience: req.audience });
  const where = place.success
    ? { platform: place.data.platform, ...(place.data.audience ? { audience: place.data.audience } : {}) }
    : null;
  if (!where || !serverMayReceive(where))
    return refuse('not-available', `${FEATURE_NAMES.perspectives} works only on public posts.`);

  const label = title?.trim() ? title.trim().slice(0, LABEL_CHARS) : new URL(url).hostname;
  const checked = (answer: PerspectivesResponse): PerspectivesResponse =>
    answer.ok && !leansMatchRegistry(answer.result, registry) ? refuse('not-available', LEANS_MISMATCH) : answer;

  const cfg = device.aiSource;
  if (cfg?.kind === 'server') {
    const account = await serverAccountItem.getValue();
    if (!account || !sourceCapabilities(cfg, serverOfferFrom(account)).perspectives)
      return refuse('unsupported', `This server doesn't offer ${FEATURE_NAMES.perspectives}.`);
    return track(tabId, key, label, 'perspectives', cfg, async () =>
      checked(await cancelOnTabClose(tabId, (signal) => runPerspectivesViaServer(account, { link, ...where }, { signal }))),
    );
  }
  const own = capableOwnKey(cfg, device, 'perspectives');
  if (!own) return refuse('unsupported', NEEDS.perspectives);
  const mode = await ownKeyMode(own, device);
  if (isRefusal(mode)) return mode;
  const compare = async () => checked(await compareOwnKey(link, registry, own, mode));
  return track(tabId, key, label, 'perspectives', own, compare, device.webSearch);
}

/** The pipeline on the person's key: no `resolveLink` (the extension never fetches a link), no ceiling (own key). */
async function compareOwnKey(link: SharedLink, registry: Registry, cfg: OwnKey, mode: OwnKeyMode): Promise<PerspectivesResponse> {
  // Every call's spend is in the ledger before the answer goes back, as fact-check's.
  const spends: Promise<void>[] = [];
  try {
    const client = await clientFor(cfg);
    const run = await runPerspectives(link, perspectivesDepsForMode(client, mode, registry), {
      onUsage: (u) => spends.push(recordSpend(u.model, u.usage, { posts: 0, failed: u.failed })),
    });
    await Promise.all(spends);
    return { ok: true, result: run.result, ...(run.costMicros !== undefined ? { costMicros: run.costMicros } : {}) };
  } catch (err) {
    await Promise.allSettled(spends);
    return { ok: false, error: ownKeyError(err, cfg, 'perspectives') };
  }
}
