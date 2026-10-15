/**
 * AI routes (R20): which model serves each task, stored in the database. A route is allowed only when its data never
 * stays with a third party: an Anthropic model eligible for zero data retention, or an OpenAI-compatible server on
 * hardware the operator controls. It serves requests only after it has passed its eval for the prompt version this
 * server builds, so a prompt change (a bump of `PROMPT_VERSION`, or `FACTCHECK_PROMPT_VERSION` for research and
 * synthesis) forces a new eval. The routes a server has follow its environment (R36): `syncRouteFromConfig` runs at
 * every start.
 */
import { AIError } from '@unalgorithm/ai';
import { PROMPT_VERSION } from '@unalgorithm/core';
import { FACTCHECK_PROMPT_VERSION } from '@unalgorithm/research';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { aiRoutes } from '../db/schema.ts';
import type { Logger } from '../log.ts';

export type AiRoute = typeof aiRoutes.$inferSelect;

/** What a route is, without its id, state or eval: the part the guard checks. */
export type RouteSpec = Pick<AiRoute, 'task' | 'provider' | 'model' | 'baseUrl' | 'effort' | 'dataPolicy'>;

/**
 * The tasks a route can serve: `classify` (and fact-check's claims extraction), `research` (Anthropic web search) and
 * `synthesis` (the verdicts), decision D11.
 */
export const ROUTE_TASKS = ['classify', 'research', 'synthesis'] as const;
export type RouteTask = (typeof ROUTE_TASKS)[number];

/** The variable that names each task's model, so a refusal sends the admin to the right setting. */
const MODEL_VARIABLE: Record<RouteTask, string> = {
  classify: 'AI_MODEL',
  research: 'AI_RESEARCH_MODEL',
  synthesis: 'AI_SYNTHESIS_MODEL',
};

/** The prompt version a task's eval must have run on: fact-check's own for research and synthesis. */
export function routePromptVersion(task: RouteTask): number {
  return task === 'classify' ? PROMPT_VERSION : FACTCHECK_PROMPT_VERSION;
}

/**
 * Anthropic models eligible for zero data retention. Provisional until Anthropic's zero-data-retention agreement
 * confirms the list.
 */
export const ANTHROPIC_ZDR_ELIGIBLE: readonly string[] = ['claude-haiku-5-5', 'claude-sonnet-5-5'];

export type RouteCheck = { ok: true } | { ok: false; reason: string };

/**
 * The configured AI provider breaks a routing rule, so the server refuses to start. The message names the variable,
 * the rule and at most the model; never the API key or the base URL, which can hold credentials.
 */
export class RouteConfigError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RouteConfigError';
  }
}

/**
 * The guard every route passes before it is stored and again before it is served. A route's provider, base URL and
 * data policy come from `AI_PROVIDER`, `AI_BASE_URL` and `AI_DATA_POLICY`, its model from the task's own variable
 * (`AI_MODEL`, `AI_RESEARCH_MODEL` or `AI_SYNTHESIS_MODEL`), so the reasons name those.
 */
export function validateRoute(r: RouteSpec): RouteCheck {
  const no = (reason: string): RouteCheck => ({ ok: false, reason });
  if (!(ROUTE_TASKS as readonly string[]).includes(r.task)) return no(`no AI route can serve the task ${r.task}`);
  const task = r.task as RouteTask;
  if (task === 'classify' && r.effort !== 'low') return no('effort must be low for classify');
  if (task !== 'classify' && r.effort !== 'medium') return no(`effort must be medium for ${task}`);
  if (task === 'research' && r.provider !== 'anthropic') return no('the research route needs Anthropic web search');
  if (r.provider === 'anthropic') {
    if (r.dataPolicy !== 'vendor-zdr') return no('AI_DATA_POLICY must be vendor-zdr when AI_PROVIDER is anthropic');
    if (r.baseUrl !== null) return no('AI_BASE_URL must be unset when AI_PROVIDER is anthropic');
    if (!ANTHROPIC_ZDR_ELIGIBLE.includes(r.model)) {
      return no(
        `${MODEL_VARIABLE[task]} ${r.model} is not eligible for zero data retention; use one of ${ANTHROPIC_ZDR_ELIGIBLE.join(', ')}`,
      );
    }
    return { ok: true };
  }
  if (r.provider === 'openai-compatible') {
    // A third-party OpenAI-compatible vendor cannot be routed: its retention is not covered by any agreement.
    if (r.dataPolicy !== 'self-hosted') {
      return no('AI_DATA_POLICY must be self-hosted when AI_PROVIDER is openai-compatible (a model on hardware you control)');
    }
    if (!r.baseUrl) return no('AI_BASE_URL is required when AI_PROVIDER is openai-compatible');
    return { ok: true };
  }
  return no('AI_PROVIDER must be anthropic or openai-compatible');
}

/** The advisory lock key for `syncRouteFromConfig`: "UNAR" read as a 32-bit integer (migrations hold "UNAL"). */
const ROUTE_SYNC_LOCK_KEY = 1431191890;

/** A route the configuration describes for `task`, past the guard: a `RouteConfigError` when it breaks a rule. */
function checkedRoute(config: Config, task: RouteTask, model: string, effort: 'low' | 'medium'): RouteSpec {
  const { provider, baseUrl, dataPolicy } = config.ai;
  const route: RouteSpec = { task, provider, model, baseUrl: baseUrl ?? null, effort, dataPolicy };
  const check = validateRoute(route);
  if (!check.ok) throw new RouteConfigError(check.reason);
  return route;
}

/**
 * The `classify` route the configuration describes, past the guard: a `RouteConfigError` when it breaks a routing
 * rule. The server stores it at startup (`syncRouteFromConfig`); `check-config` runs the same check without a database.
 */
export function configuredRoute(config: Config): RouteSpec {
  return checkedRoute(config, 'classify', config.ai.model, 'low');
}

/**
 * Every route the configuration describes, each past the guard: `classify`, and with fact-check on `synthesis`, plus
 * `research` when no search provider is set (Anthropic web search researches then). Same provider, base URL and data
 * policy as `classify`.
 */
export function configuredRoutes(config: Config): RouteSpec[] {
  const routes = [configuredRoute(config)];
  const { factcheck } = config;
  if (factcheck.enabled) {
    routes.push(checkedRoute(config, 'synthesis', factcheck.synthesisModel, 'medium'));
    if (factcheck.search === null) routes.push(checkedRoute(config, 'research', factcheck.researchModel, 'medium'));
  }
  return routes;
}

/** The fact-check tasks, whose routes are disabled when the configuration no longer has them. */
const OPTIONAL_TASKS: readonly RouteTask[] = ['research', 'synthesis'];

/**
 * Makes the enabled routes the ones the configuration describes, at startup, and returns the `classify` route. Every
 * route is checked first and a `RouteConfigError` thrown before anything is written. A route that already matches is
 * kept with its eval result; otherwise it is disabled and the new route inserted with no eval. An enabled research or
 * synthesis route the configuration no longer has is disabled. All in one transaction: two servers starting together
 * take turns on an advisory lock, so the second finds the first one's routes and keeps them.
 */
export async function syncRouteFromConfig(db: Db, config: Config, log: Logger): Promise<AiRoute> {
  const wanted = configuredRoutes(config);

  const routes = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROUTE_SYNC_LOCK_KEY})`);
    const synced: AiRoute[] = [];
    for (const spec of wanted) {
      const [current] = await tx
        .select()
        .from(aiRoutes)
        .where(and(eq(aiRoutes.task, spec.task), eq(aiRoutes.enabled, true)));
      if (current && sameRoute(current, spec)) {
        synced.push(current);
        continue;
      }
      if (current) await tx.update(aiRoutes).set({ enabled: false }).where(eq(aiRoutes.id, current.id));
      const [inserted] = await tx.insert(aiRoutes).values(spec).returning();
      if (!inserted) throw new Error('The AI route was not inserted.');
      synced.push(inserted);
    }
    const unused = OPTIONAL_TASKS.filter((task) => !wanted.some((r) => r.task === task));
    if (unused.length) {
      await tx
        .update(aiRoutes)
        .set({ enabled: false })
        .where(and(inArray(aiRoutes.task, [...unused]), eq(aiRoutes.enabled, true)));
    }
    return synced;
  });
  for (const route of routes) {
    log.info('ai.route.synced', {
      task: route.task,
      provider: route.provider,
      model: route.model,
      eval: evalPassed(route, config.routeEvalMinAgreement) ? 'passed' : 'pending',
    });
  }
  const classify = routes.find((r) => r.task === 'classify');
  if (!classify) throw new Error('The classify route was not synced.');
  return classify;
}

/** Whether two routes are the same provider, model, endpoint, effort and data policy (the task is the caller's). */
export function sameRoute(a: RouteSpec, b: RouteSpec): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.baseUrl === b.baseUrl &&
    a.effort === b.effort &&
    a.dataPolicy === b.dataPolicy
  );
}

/** Whether the route passed its last eval, run on its task's prompt version, with at least `minAgreement`. */
function evalPassed(route: AiRoute, minAgreement: number): boolean {
  return (
    route.evalPassedAt !== null &&
    route.evalPromptVersion === routePromptVersion(route.task as RouteTask) &&
    route.evalAgreement !== null &&
    route.evalAgreement >= minAgreement
  );
}

/** `ai.route.eval_pending` is logged at most this often per logger, however many requests are refused. */
const EVAL_PENDING_LOG_INTERVAL_MS = 60_000;
const evalPendingLoggedAt = new WeakMap<Logger, number>();

/**
 * The enabled route for `task`, if any, as stored: neither the guard nor the eval gate is applied. `resolveRoute`
 * applies both before a request is served; the eval command (`route-eval`) evaluates the route before it has passed.
 */
export async function enabledRoute(db: Db, task: RouteTask): Promise<AiRoute | undefined> {
  const [route] = await db
    .select()
    .from(aiRoutes)
    .where(and(eq(aiRoutes.task, task), eq(aiRoutes.enabled, true)));
  return route;
}

/**
 * The route that serves `task`: enabled, allowed by the guard, and past its eval for the current prompt version with
 * at least `minAgreement`. Otherwise `AIError` `not-available`, which the app answers with 503. `log` is required so a
 * refused route always says why in the log (`ai.route.eval_pending`, at most once a minute).
 */
export async function resolveRoute(db: Db, task: RouteTask, minAgreement: number, log: Logger): Promise<AiRoute> {
  const route = await enabledRoute(db, task);
  if (!route) throw new AIError('not-available', 'No AI route is configured.');
  const check = validateRoute(route);
  if (!check.ok) throw new AIError('not-available', `The AI route is not allowed: ${check.reason}`);
  if (!evalPassed(route, minAgreement)) {
    const now = Date.now();
    if (now - (evalPendingLoggedAt.get(log) ?? Number.NEGATIVE_INFINITY) >= EVAL_PENDING_LOG_INTERVAL_MS) {
      evalPendingLoggedAt.set(log, now);
      log.warn('ai.route.eval_pending', { task, provider: route.provider, model: route.model });
    }
    throw new AIError('not-available', 'The AI route has not passed its evaluation.');
  }
  return route;
}

export interface EvalResult {
  /** The share of eval cases the route agreed on, 0 to 1. */
  agreement: number;
  /** The `PROMPT_VERSION` the eval ran with. */
  promptVersion: number;
  passed: boolean;
}

/** Stores an eval run's result on the route (the `route-eval` command is the one production caller). */
export async function recordEval(db: Db, routeId: string, { agreement, promptVersion, passed }: EvalResult): Promise<AiRoute> {
  const [route] = await db
    .update(aiRoutes)
    .set({ evalAgreement: agreement, evalPromptVersion: promptVersion, evalPassedAt: passed ? sql`now()` : null })
    .where(eq(aiRoutes.id, routeId))
    .returning();
  if (!route) throw new Error('No AI route has that id.');
  return route;
}
