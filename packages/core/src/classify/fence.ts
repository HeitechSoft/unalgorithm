/**
 * Post text is untrusted: anyone can write a post that says "ignore your instructions". Before it goes into a
 * prompt it is normalized (NFKC), stripped of control, zero-width and bidi-override characters, and its
 * `& < >` are escaped so it can never close or forge the tags around it. Tags also carry a random nonce.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// Zero-width characters, soft hyphen, word joiner, BOM, and bidi embeddings/overrides/isolates.
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * The canonical form of text that may reach a model: NFKC, without control, zero-width or bidi characters. Names are
 * masked in this form too, so a tagged "𝓙𝓪𝓷𝓮" or "Code Club 👩‍💻" matches the text it appears in.
 */
export function canonicalText(text: string): string {
  return text.normalize('NFKC').replace(CONTROL, '').replace(INVISIBLE, '');
}

export function neutralize(text: string, maxChars = Number.POSITIVE_INFINITY): string {
  let t = canonicalText(text);
  t = t
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length > maxChars) t = `${t.slice(0, maxChars).trimEnd()}…`;
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape a value for use inside a double-quoted tag attribute. */
export function attr(value: string): string {
  return neutralize(value, 300).replace(/"/g, '&quot;');
}

/** 8 hex characters. Pass a fixed nonce in tests for deterministic prompts. */
export function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
