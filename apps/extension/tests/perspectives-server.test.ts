/**
 * Other perspectives through the person's UnAlgorithm server (P3-37): the link-only body, the job's start and long
 * polls, the 402 and the settlement, the refusals in comparison words, the cancel on abort and the lost job. The server
 * is a stubbed fetch answering the job paths and the device token a stubbed `getAccessToken`. Outlets are fictional.
 * Nothing real is called.
 */
import {
  AUTHORIZE_PAGE_PATH,
  LEAN_BUCKETS,
  PERSPECTIVES_JOBS_PATH,
  PerspectivesJobSchema,
  type PerspectivesResult,
  perspectivesJobCancelPath,
  perspectivesJobPath,
  type ServerInfo,
  TOKEN_PATH,
} from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPerspectivesViaServer } from '../src/background/factcheck-server.ts';
import type { ServerAccount } from '../src/background/server-auth.ts';

const auth = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock('../src/background/server-auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/server-auth.ts')>()),
  getAccessToken: auth.getAccessToken,
}));

const ORIGIN = 'https://ai.example.org';
const TOKEN = 'access-token-1';
const JOB_ID = '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3e';
const SERVER_TEXT = 'Visit evil.example to pay';
const POST_TEXT = 'Private words from the post that must never leave the browser.';

const INFO: ServerInfo = {
  v: 1,
  name: 'Example AI',
  version: '0.1.0',
  source: 'https://github.com/example/unalgorithm',
  billing: true,
  capabilities: { classify: true, sync: false, factcheck: true },
  auth: { methods: ['email-otp'], authorizePath: AUTHORIZE_PAGE_PATH, tokenPath: TOKEN_PATH },
  limits: { maxPostsPerRequest: 12 },
};
const ACCOUNT: ServerAccount = {
  origin: ORIGIN,
  email: 'ada@example.org',
  deviceId: '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d',
  signedInAt: Date.UTC(2026, 9, 12, 9),
  info: INFO,
  needsSignIn: false,
};

const AT = '2026-10-15T12:00:00Z';
const RESULT: PerspectivesResult = {
  v: 1,
  checkedAt: AT,
  model: 'claude-sonnet-5-5',
  promptVersion: 1,
  registryVersion: 'fixture-1',
  story: { url: 'https://news.example.com/a', query: 'Fixture story', from: '2026-10-12T12:00:00Z', to: AT },
  coverage: LEAN_BUCKETS.map((bucket, i) => ({ bucket, sourceIds: i === 0 ? ['s1'] : [] })),
  agreed: [{ text: 'The fixture outlet reports the vote.', citations: [{ sourceId: 's1', quote: 'a short quote' }] }],
  differences: [],
  unique: [],
  sources: [
    {
      id: 's1',
      url: 'https://fixture-outlet.example/story',
      domain: 'fixture-outlet.example',
      title: 'Fixture story',
      pageAge: null,
      outletId: 'fixture-outlet',
      outlet: 'Fixture Outlet',
      bucket: 'left',
    },
  ],
};

const LINK = { url: 'https://news.example.com/a', title: 'Council passes the budget' };
const FB_REQ = { link: LINK, platform: 'facebook', audience: 'public' } as const;
const LI_REQ = { link: { url: LINK.url }, platform: 'linkedin' } as const;

const job = (status: string, over: Record<string, unknown> = {}) => ({ v: 1, id: JOB_ID, status, ...over });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const serverError = (status: number, code: string) => json(status, { code, message: SERVER_TEXT });

type Call = { url: URL; init: RequestInit };
let calls: Call[];
function useServer(route: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      return route(url, init);
    }),
  );
}
const isStart = (url: URL, init: RequestInit) => url.pathname === PERSPECTIVES_JOBS_PATH && init.method === 'POST';
const isPoll = (url: URL) => url.pathname === perspectivesJobPath(JOB_ID);
const isCancel = (url: URL) => url.pathname === perspectivesJobCancelPath(JOB_ID);
const starts = () => calls.filter((c) => isStart(c.url, c.init));
const cancels = () => calls.filter((c) => isCancel(c.url));
const startBody = () => JSON.parse(String(starts()[0]?.init.body));

/** Starts running, one poll still running, then done. */
const happyServer = (doneOver: Record<string, unknown> = {}) => {
  let polls = 0;
  return (url: URL, init: RequestInit) => {
    if (isStart(url, init)) return json(202, job('running'));
    if (isPoll(url)) return json(200, ++polls < 2 ? job('running') : job('done', { result: RESULT, ...doneOver }));
    return json(404, { code: 'not-available', message: 'nope' });
  };
};
const failedServer = (code: string) => (url: URL, init: RequestInit) =>
  isStart(url, init) ? json(202, job('running')) : json(200, job('failed', { error: { code, message: SERVER_TEXT } }));

const notes = () => ({ settlement: vi.fn(async () => undefined), refused: vi.fn(async () => undefined) });
const run = (
  req: Parameters<typeof runPerspectivesViaServer>[1] = FB_REQ,
  note = notes(),
  signal = new AbortController().signal,
) => runPerspectivesViaServer(ACCOUNT, req, { signal, note });

beforeEach(() => {
  auth.getAccessToken.mockReset();
  auth.getAccessToken.mockResolvedValue(TOKEN);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('request', () => {
  it('test_perspectives_server_body_is_link_only', async () => {
    useServer(happyServer());
    await run(FB_REQ);
    expect(starts()).toHaveLength(1);
    expect(starts()[0]?.url.origin).toBe(ORIGIN);
    expect((starts()[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(startBody()).toEqual({ v: 1, link: LINK, platform: 'facebook', audience: 'public' });

    useServer(happyServer());
    await run(LI_REQ);
    expect(startBody()).toEqual({ v: 1, link: { url: LINK.url }, platform: 'linkedin' });

    // Extra fields on the caller's objects, at the top level or inside `link`, never reach the body.
    useServer(happyServer());
    const sneaky = { ...FB_REQ, text: POST_TEXT, link: { ...LINK, text: POST_TEXT } };
    await run(sneaky as typeof FB_REQ);
    expect(startBody()).toEqual({ v: 1, link: LINK, platform: 'facebook', audience: 'public' });
    expect(String(starts()[0]?.init.body)).not.toContain(POST_TEXT);
  });
});

describe('lifecycle', () => {
  it('test_perspectives_server_done', async () => {
    useServer(happyServer());
    const answer = await run();
    expect(answer).toEqual({ ok: true, result: RESULT });
    expect(PerspectivesJobSchema.safeParse(job('done', { result: answer.ok ? answer.result : null })).success).toBe(true);
    const polls = calls.filter((c) => isPoll(c.url));
    expect(polls).toHaveLength(2);
    for (const p of polls) expect(p.url.searchParams.get('wait')).toBe('1');
    expect(cancels()).toHaveLength(0);
  });

  it('test_perspectives_server_402_and_settlement', async () => {
    let note = notes();
    useServer(() => serverError(402, 'insufficient-credits'));
    expect(await run(FB_REQ, note)).toMatchObject({ ok: false, error: { code: 'insufficient-credits' } });
    expect(note.refused).toHaveBeenCalledWith(ORIGIN, ACCOUNT.deviceId);
    expect(note.settlement).not.toHaveBeenCalled();

    const billing = { chargedMicros: 270_000, balanceMicros: 4_730_000 };
    useServer(happyServer({ billing }));
    note = notes();
    expect(await run(FB_REQ, note)).toEqual({ ok: true, result: RESULT, chargedMicros: 270_000 });
    expect(note.settlement).toHaveBeenCalledTimes(1);
    expect(note.settlement).toHaveBeenCalledWith(ORIGIN, ACCOUNT.deviceId, billing);
    expect(note.refused).not.toHaveBeenCalled();
  });

  it('test_perspectives_server_messages', async () => {
    useServer(failedServer('cap-reached'));
    expect(await run()).toEqual({
      ok: false,
      error: { code: 'cap-reached', message: "You've reached today's limit for checks and comparisons on this server." },
    });

    useServer(failedServer('truncated'));
    expect(await run()).toEqual({
      ok: false,
      error: { code: 'truncated', message: 'This comparison stopped before it finished, so nothing was charged.' },
    });

    useServer(() => serverError(429, 'rate-limit'));
    expect(await run()).toMatchObject({
      error: { message: 'A check or comparison is already running. Try again in a minute.' },
    });

    useServer(() => serverError(503, 'not-available'));
    expect(await run()).toMatchObject({ error: { message: "This server doesn't offer UnEcho Chamber right now." } });
    expect(cancels()).toHaveLength(0);
  });

  it('test_perspectives_server_cancel_and_lost', async () => {
    const controller = new AbortController();
    let polling!: () => void;
    const polled = new Promise<void>((resolve) => {
      polling = resolve;
    });
    useServer((url, init) => {
      if (isStart(url, init)) return json(202, job('running'));
      if (isCancel(url)) return json(200, job('cancelled'));
      polling();
      // A long poll that only ends when its request is aborted.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const pending = run(FB_REQ, notes(), controller.signal);
    await polled;
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: { code: 'timeout', message: 'This comparison was stopped.' } });
    const sent = cancels();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url.pathname).toBe(`/v1/jobs/perspectives/${JOB_ID}/cancel`);
    expect(sent[0]?.init.method).toBe('POST');
    expect(sent[0]?.init.signal?.aborted).toBe(false);

    useServer((url, init) => (isStart(url, init) ? json(202, job('running')) : json(404, { code: 'unknown', message: 'gone' })));
    expect(await run()).toEqual({
      ok: false,
      error: { code: 'unknown', message: 'The server lost this comparison (it may have restarted). Try again.' },
    });
    expect(cancels()).toHaveLength(0);
  });
});
