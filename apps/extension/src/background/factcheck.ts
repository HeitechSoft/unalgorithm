import { AIError, describeError } from '@unalgorithm/ai';
import { type AISourceConfig, createLock, SOURCE_LIMITS, serverOfferFrom, sourceCapabilities } from '@unalgorithm/core';
import { type AIErrorCode, type PostForAI, type PostKey, serverMayReceive } from '@unalgorithm/protocol';
import { aiRetriever, FACTCHECK_MODELS, runFactcheck } from '@unalgorithm/research';
import { browser } from 'wxt/browser';
import type { BgError, BgResponses } from '../lib/messages.ts';
import { type FactcheckEntry, factcheckItem, readDevice } from '../lib/storage.ts';
import { clientFor, hasPermission, parsePostInput, recordSpend } from './ai.ts';
import { runFactcheckViaServer } from './factcheck-server.ts';
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

const refuse = (code: AIErrorCode, message: string): FactcheckResponse => ({ ok: false, error: { code, message } });

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

/** The text a failed check shows: fact-check wording where the classify text `describeError` gives would be wrong. */
function factcheckError(err: unknown): BgError {
  const e = err instanceof AIError ? err : new AIError('unknown', String(err));
  if (e.code === 'unsupported') return { code: e.code, message: "Web search isn't turned on for this Anthropic account." };
  if (e.code === 'refusal') return { code: e.code, message: 'The AI declined to check this post.' };
  return { code: e.code, message: describeError(e.code, 'Anthropic') };
}

/**
 * Fact-check one post for a feed tab, on the person's own Anthropic key or on their UnAlgorithm server. Every gate is
 * checked again here, and each refusal returns before anything is sent. The result is kept in the tab's session
 * storage, where the side panel reads it.
 */
export async function runFactcheckForTab(tabId: number, key: PostKey, input: Omit<PostForAI, 'ref'>): Promise<FactcheckResponse> {
  const device = await readDevice();
  if (!device.labs.factcheck) return refuse('not-available', 'Turn on Fact-check in Settings → Labs.');
  const cfg = device.aiSource;
  if (cfg?.kind === 'server') return runOnServer(tabId, key, input, cfg);
  if (cfg?.kind !== 'anthropic' || !sourceCapabilities(cfg).factcheck)
    return refuse('unsupported', 'Fact-check needs your own Anthropic key.');
  const post = parsePostInput(input, SOURCE_LIMITS.anthropic.maxPostChars);
  if (!post) return refuse('bad-request', 'This post could not be read.');
  // Only public posts, own keys too (decision D2).
  if (!serverMayReceive(post)) return refuse('not-available', ONLY_PUBLIC);
  return track(tabId, key, post, cfg, () => runOnAnthropic(post, cfg));
}

const ONLY_PUBLIC = 'Fact-check works only on public posts.';

/** The server's own check (P3-21): the server meters, so a done entry has no `costMicros`. */
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
  return track(tabId, key, post, cfg, async () => {
    const controller = new AbortController();
    running.set(tabId, controller);
    try {
      return await runFactcheckViaServer(account, { ...post, ref: 'p1' }, { signal: controller.signal });
    } finally {
      if (running.get(tabId) === controller) running.delete(tabId);
    }
  });
}

/** The three Anthropic calls; every call's spend is in the ledger with `posts: 0` (no daily post cap). */
async function runOnAnthropic(post: PostForAI, cfg: Extract<AISourceConfig, { kind: 'anthropic' }>): Promise<FactcheckResponse> {
  // Every call's spend is in the ledger before the answer goes back, so the popup's cost today includes it.
  const spends: Promise<void>[] = [];
  try {
    const client = await clientFor(cfg);
    const run = await runFactcheck(
      { ...post, ref: 'p1' },
      { client, retriever: aiRetriever(client, FACTCHECK_MODELS.research) },
      { onUsage: (u) => spends.push(recordSpend(u.model, u.usage, { posts: 0, failed: u.failed })) },
    );
    await Promise.all(spends);
    return { ok: true, result: run.result, ...(run.costMicros !== undefined ? { costMicros: run.costMicros } : {}) };
  } catch (err) {
    await Promise.allSettled(spends);
    return { ok: false, error: factcheckError(err) };
  }
}

/**
 * One check per tab: the host permission, then a `running` entry, then `run`, whose answer settles the entry. Nothing
 * is settled when the tab closed meanwhile (its entries are gone): the item stays removed.
 */
async function track(
  tabId: number,
  key: PostKey,
  post: PostForAI,
  cfg: AISourceConfig,
  run: () => Promise<FactcheckResponse>,
): Promise<FactcheckResponse> {
  if (inFlight.has(tabId)) return refuse('rate-limit', 'A check is already running on this page.');
  inFlight.add(tabId);
  try {
    if (!(await hasPermission(cfg))) return refuse('host-permission', describeError('host-permission', 'Anthropic'));

    const startedAt = Date.now();
    const mine = (e: FactcheckEntry) => e.startedAt === startedAt && e.key === key && e.status === 'running';
    const settle = (patch: Partial<FactcheckEntry>) =>
      updateEntries(tabId, (entries) => (entries.some(mine) ? entries.map((e) => (mine(e) ? { ...e, ...patch } : e)) : null));
    // Another `running` entry can only be left by a worker that died mid-check: this tab is in `inFlight` now.
    const stale: Partial<FactcheckEntry> = { status: 'failed', error: factcheckError(new AIError('timeout', 'Stopped.')) };
    await updateEntries(tabId, (entries) => [
      { key, label: post.text.slice(0, LABEL_CHARS), startedAt, status: 'running' },
      ...entries.map((e) => (e.status === 'running' ? { ...e, ...stale } : e)),
    ]);

    const answer = await run();
    if (answer.ok) {
      const cost = answer.costMicros !== undefined ? { costMicros: answer.costMicros } : {};
      await settle({ status: 'done', result: answer.result, ...cost });
    } else {
      await settle({ status: 'failed', error: answer.error });
    }
    return answer;
  } finally {
    inFlight.delete(tabId);
  }
}
