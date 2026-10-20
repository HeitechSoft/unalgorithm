/**
 * On-device AI failures say what is wrong with this browser (ADR 0003). Chromium builds without Google's on-device
 * runtime offer the Prompt API and say a model is `available`, then answer every prompt from a stand-in that echoes it:
 * the card must say so, not "Chrome rejected the request", and nothing is saved. The Prompt API here is a stand-in;
 * the brand names are stubbed as in tests/browser-kind.test.ts.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { describeError } from '@unalgorithm/ai';
import { defaultDevice } from '@unalgorithm/core';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { classifyItems, onDeviceStatus, saveSource, testSource } from '../src/background/ai.ts';
import { clearCache } from '../src/background/idb.ts';
import { AiSetup } from '../src/components/AiSetup.tsx';
import { type BgRequest, sendToBackground } from '../src/lib/messages.ts';
import { deviceItem, readDevice } from '../src/lib/storage.ts';

vi.mock('../src/lib/messages.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/messages.ts')>()),
  sendToBackground: vi.fn(),
}));

const CHROMIUM = ['Not A(Brand', 'Chromium'];
const CHROME = ['Not)A;Brand', 'Chromium', 'Google Chrome'];
const EDGE = ['Not=A?Brand', 'Chromium', 'Microsoft Edge'];

const CHROMIUM_TEXT =
  "This browser has no on-device model behind its built-in AI. Chromium builds don't include one: built-in AI needs Google Chrome, or Edge's preview. Choose another option.";

const item = (text: string) => ({
  key: 'li:urn:li:activity:1' as const,
  input: {
    platform: 'linkedin' as const,
    text,
    textComplete: true,
    authorKind: 'person' as const,
    isReshare: false,
    media: 'none' as const,
  },
});

const valid = {
  results: [
    {
      id: 'p1',
      topics: ['automation'],
      noise: [],
      reason: 'About automation.',
      relevance: 70,
      isNews: false,
      hasCheckableClaims: false,
    },
  ],
};

/** What the stand-in Prompt API reports and answers. The background keeps one client, so tests change these. */
let availability: string;
let answer: (user: string) => string;

const LanguageModel = {
  async availability() {
    return availability;
  },
  async create(o: { initialPrompts?: { content: string }[] }) {
    const system = o.initialPrompts?.[0]?.content ?? '';
    return {
      async clone() {
        return {
          async prompt(user: string) {
            return answer(user).replace('{system}', system);
          },
          destroy() {},
        };
      },
      destroy() {},
    };
  },
};

/** Chromium's stand-in model: the formatted prompt, then a tail that satisfies the schema. */
const echo = (user: string) =>
  `CPU backendFastest inferenceTopK: 64, Temp: 1System: {system} End.User: ${user} End.Model: {"results":[]}`;

function stubBrands(brands: string[]) {
  Object.defineProperty(navigator, 'userAgentData', {
    value: { brands: brands.map((brand) => ({ brand, version: '154' })), mobile: false, platform: 'Linux' },
    configurable: true,
  });
}

beforeEach(async () => {
  fakeBrowser.reset();
  await clearCache();
  availability = 'available';
  answer = echo;
  vi.stubGlobal('LanguageModel', LanguageModel);
  stubBrands(CHROMIUM);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'userAgentData');
});

describe('testSource for on-device AI', () => {
  it('test_echo_model_says_chromium_has_no_model', async () => {
    const res = await testSource({ kind: 'on-device' });
    expect(res).toStrictEqual({ ok: false, error: { code: 'not-available', message: CHROMIUM_TEXT } });
  });

  it('test_echo_model_message_names_the_browser', async () => {
    stubBrands(CHROME);
    const chrome = await testSource({ kind: 'on-device' });
    expect(chrome.ok || chrome.error.message).toBe(
      'Chrome says its built-in AI is ready, but no model answered. Update Chrome and try again, or choose another option.',
    );
    stubBrands(EDGE);
    const edge = await testSource({ kind: 'on-device' });
    expect(edge.ok || edge.error.message).toBe(
      "Edge says its built-in AI is ready, but no model answered. Edge's built-in AI is a preview: choose another option for now.",
    );
    for (const r of [chrome, edge]) expect(r.ok || r.error.message).not.toMatch(/rejected/);
  });

  it('test_working_model_passes', async () => {
    answer = () => JSON.stringify(valid);
    const res = await testSource({ kind: 'on-device' });
    expect(res).toMatchObject({ ok: true, model: 'chrome-built-in', mode: 'on-device', models: [] });
  });

  it('test_unreadable_answer_is_not_a_rejection', async () => {
    // JSON, but not the schema's: the model answered, nobody rejected anything.
    answer = () => '{"results":"none"}';
    const res = await testSource({ kind: 'on-device' });
    expect(res).toStrictEqual({
      ok: false,
      error: { code: 'bad-request', message: "Chrome's built-in AI gave an answer unAlgorithm couldn't read." },
    });
  });

  it('test_model_not_ready', async () => {
    availability = 'downloading';
    expect(await testSource({ kind: 'on-device' })).toStrictEqual({
      ok: false,
      error: { code: 'not-available', message: 'The on-device model is still downloading. Try again when it finishes.' },
    });
    availability = 'downloadable';
    const later = await testSource({ kind: 'on-device' });
    expect(later.ok || later.error.message).toBe("The on-device model isn't downloaded yet. Choose Download and turn on.");
    availability = 'unavailable';
    const none = await testSource({ kind: 'on-device' });
    expect(none.ok || none.error.message).toBe(describeError('not-available'));
    // No Prompt API at all (Firefox, older Chromium).
    vi.unstubAllGlobals();
    expect(await onDeviceStatus()).toBe('no-api');
    const missing = await testSource({ kind: 'on-device' });
    expect(missing.ok || missing.error.message).toBe(describeError('not-available'));
  });
});

describe('the feed with on-device AI', () => {
  it('test_echo_model_pauses_ai_with_the_reason', async () => {
    await deviceItem.setValue({ ...defaultDevice('dev1'), aiSource: { kind: 'on-device' } });
    const res = await classifyItems([item('We moved our forms online. What should we automate next?')]);
    expect(res.results).toStrictEqual([
      { key: 'li:urn:li:activity:1', status: 'failed', code: 'not-available', message: CHROMIUM_TEXT, retryable: false },
    ]);
    expect(res.pause).toStrictEqual({ code: 'not-available', message: CHROMIUM_TEXT });
  });
});

describe('the on-device card', () => {
  it('test_turn_on_shows_why_and_saves_nothing', async () => {
    vi.mocked(sendToBackground).mockImplementation((async (msg: BgRequest) => {
      if (msg.type === 'onDeviceStatus') return { availability: await onDeviceStatus() };
      if (msg.type === 'testSource') return testSource(msg.config);
      if (msg.type === 'saveSource') return saveSource(msg.config);
      return undefined;
    }) as never);
    await deviceItem.setValue(defaultDevice('dev1'));
    const user = setupUser();
    render(<AiSetup device={defaultDevice('dev1')} />);
    const card = await screen.findByRole('radio', { name: /^On this device/ });
    await waitFor(() => expect((card as HTMLInputElement).disabled).toBe(false));
    await user.click(card);
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText(CHROMIUM_TEXT)).toBeTruthy();
    expect(screen.getByText("That didn't work")).toBeTruthy();
    expect(screen.queryByText(/rejected/)).toBeNull();
    expect(vi.mocked(sendToBackground).mock.calls.some(([m]) => (m as BgRequest).type === 'saveSource')).toBe(false);
    expect((await readDevice()).aiSource).toBeNull();
  });
});
