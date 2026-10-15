/**
 * Reads an answer from a server up to a byte cap. A server, self-hosted or compromised, decides how much it sends; the
 * extension decides how much it reads, so an endless or giant answer is dropped instead of held in memory or handed
 * on to storage (audit n=11). Small JSON answers (discovery, tokens, balance) fit well inside the default.
 */

/** The cap for the small answers: discovery, tokens, balance. */
export const MAX_SERVER_BODY_BYTES = 64 * 1024;

/** The body as text, '' when there is none, or null when it is longer than `maxBytes` (then it is not read on). */
export async function readBoundedText(res: Response, maxBytes = MAX_SERVER_BODY_BYTES): Promise<string | null> {
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** The body as JSON, or null when it is longer than `maxBytes`, empty or not JSON. */
export async function readBoundedJson(res: Response, maxBytes = MAX_SERVER_BODY_BYTES): Promise<unknown> {
  const text = await readBoundedText(res, maxBytes);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
