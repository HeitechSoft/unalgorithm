import { detectProvider } from '@unalgorithm/ai/presets';
import { someString } from './strings.ts';

/**
 * The credential guard (R17), on both sides of a push: the extension withholds an item that trips it (CL3-05) and the
 * server refuses one with reason `credential` (CL3-07). The extension never reads secrets into settings (ADR 0005), so
 * a key can only reach an item by someone pasting it into, say, an interest. Only keys with a known provider prefix
 * are found; random tokens such as refresh tokens are kept out of payloads by construction (CL3-19).
 */

/** Splits text into tokens; `.`, `-`, `_` and `/` stay inside a token, as they do inside provider keys. */
const TOKEN_SEPARATORS = /[\s"'`,;:()<>[\]{}=]+/;
/** Shorter tokens are words that merely start like a key (`sk-learn`). */
const MIN_KEY_LENGTH = 20;

function holdsKey(s: string): boolean {
  if (s.length < MIN_KEY_LENGTH) return false;
  return s.split(TOKEN_SEPARATORS).some((token) => token.length >= MIN_KEY_LENGTH && detectProvider(token) !== undefined);
}

/**
 * True when any string in `value` (object keys and values, any depth) holds a token that looks like an AI provider's
 * API key. Callers check an item's key too, by its segments: `containsCredential(item.key.split('.'))`.
 */
export function containsCredential(value: unknown): boolean {
  return someString(value, holdsKey);
}
