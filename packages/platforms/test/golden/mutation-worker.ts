import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

/**
 * Runs shards of the mutation suite (mutation-shard.ts) in a worker thread, so the big pages' mutations run in
 * parallel: jsdom reads a 300 KB capture in about half a second, and each of them gets some twenty mutations. jsdom is
 * set up the way vitest's jsdom environment sets it up: the window's properties on the global object, its functions
 * bound to it. Node strips the TypeScript (22.18 and later).
 */
interface JsdomModule {
  JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => { window: Window & Record<string, unknown> };
}

// jsdom ships no types; the root's devDependency is what vitest's environment uses too.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as JsdomModule;
const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://localhost:3000/',
  pretendToBeVisual: true,
});
const global = globalThis as unknown as Record<string, unknown>;
for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis) continue;
  const value = window[key];
  // Functions such as getComputedStyle need the window as `this`; constructors (capitalised) must stay unbound.
  global[key] = typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(window) : value;
}
global.window = window;
global.document = window.document;

const { runShard } = await import('./mutation-shard.ts');
const jobs: import('./mutation-shard.ts').ShardJob[] = workerData;
parentPort?.postMessage(jobs.map(runShard));
