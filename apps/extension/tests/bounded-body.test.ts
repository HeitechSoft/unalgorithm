/**
 * Answers from a server are read up to a byte cap (audit n=11): a server, self-hosted or compromised, cannot make the
 * extension hold an answer of any size in memory, or hand one on to storage.
 */
import { describe, expect, it, vi } from 'vitest';
import { readBoundedJson, readBoundedText } from '../src/background/bounded-body.ts';

/** A body that streams `chunk` forever, and records whether it was cancelled. */
function endless(chunk: Uint8Array) {
  const seen = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      seen.pulls++;
      controller.enqueue(chunk);
    },
    cancel: () => {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}

describe('readBoundedText', () => {
  it('test_reads_an_answer_within_the_cap', async () => {
    expect(await readBoundedText(new Response('{"ok":true}'), 64)).toBe('{"ok":true}');
    // The cap counts bytes, and a character split across chunks still decodes.
    const euro = new TextEncoder().encode('€€');
    const split = new ReadableStream<Uint8Array>({
      start: (c) => {
        c.enqueue(euro.slice(0, 4));
        c.enqueue(euro.slice(4));
        c.close();
      },
    });
    expect(await readBoundedText(new Response(split), 6)).toBe('€€');
    expect(await readBoundedText(new Response('€€'), 5)).toBeNull();
    expect(await readBoundedText(new Response(null, { status: 204 }), 64)).toBe('');
  });

  it('test_stops_reading_past_the_cap', async () => {
    const { body, seen } = endless(new Uint8Array(1024));
    expect(await readBoundedText(new Response(body), 10 * 1024)).toBeNull();
    expect(seen.cancelled).toBe(true);
    expect(seen.pulls).toBeLessThan(20);
  });

  it('test_refuses_a_declared_length_past_the_cap_unread', async () => {
    const { body, seen } = endless(new Uint8Array(1024));
    const res = new Response(body, { headers: { 'content-length': String(1 << 30) } });
    const read = vi.spyOn(res, 'text');
    expect(await readBoundedText(res, 64 * 1024)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(seen.cancelled).toBe(true);
  });
});

describe('readBoundedJson', () => {
  it('test_null_for_too_large_empty_or_not_json', async () => {
    expect(await readBoundedJson(new Response('{"v":1}'), 64)).toStrictEqual({ v: 1 });
    expect(await readBoundedJson(new Response(`{"v":"${'x'.repeat(100)}"}`), 64)).toBeNull();
    expect(await readBoundedJson(new Response(''), 64)).toBeNull();
    expect(await readBoundedJson(new Response('<html>'), 64)).toBeNull();
  });
});
