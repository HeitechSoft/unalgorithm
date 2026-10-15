import { type AISourceConfig, canonicalText } from '@unalgorithm/core';
import { ACCOUNT_PAGE_PATH } from '@unalgorithm/protocol';

/**
 * How a `server` AI source is named on screen (R25, docs/brand.md). The same server code runs HeitechSoft's Cloud and
 * anyone's self-hosted copy, so "UnAlgorithm Cloud" is earned by the origin alone, never by what a server says about
 * itself. This module is the only place that knows the pinned origin.
 */
export const PINNED_CLOUD_ORIGIN = 'https://cloud.unalgorithm.app';

const CLOUD = 'UnAlgorithm Cloud';
const MAX_SERVER_NAME = 80;
const NEVER_SENT =
  "Author names, emails and phone numbers are never sent, and Facebook posts that aren't public stay on this computer.";

export interface ServerLabel {
  /** "UnAlgorithm Cloud" for the pinned origin, otherwise the server's host (port included). */
  title: string;
  /** Empty when the address can't be parsed. */
  host: string;
  isCloud: boolean;
  /** The server's own name from discovery, shown as secondary text for servers other than the Cloud. */
  serverName?: string;
}

export function serverLabel(baseUrl: string, info?: { name: string }): ServerLabel {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { title: 'Your server', host: '', isCloud: false };
  }
  const { host } = url;
  if (url.origin === PINNED_CLOUD_ORIGIN) return { title: CLOUD, host, isCloud: true };
  // Cut by code points, so an emoji at the cut is dropped whole rather than left as half a surrogate pair.
  const name = info ? Array.from(canonicalText(info.name).trim()).slice(0, MAX_SERVER_NAME).join('').trim() : '';
  const shown = name && !borrowsCloudName(name) && name.toLowerCase() !== host ? { serverName: name } : {};
  return { title: host, host, isCloud: false, ...shown };
}

/**
 * Letters from other alphabets that pass for the letters of "UnAlgorithm Cloud" (after Unicode's confusables list):
 * Cyrillic, Greek, Armenian, Cherokee and Lisu letters, Latin small capitals, and digits. `i` and `l` share an entry
 * because a capital I passes for either. Case matters (Greek capital eta looks like H, small eta like n), so this is
 * read before lowercasing. Code points, because the characters themselves can't be told apart in source.
 */
const LOOKALIKES: Record<string, number[]> = {
  a: [0x0430, 0x0410, 0x03b1, 0x0391, 0x0251, 0x1d00, 0x13aa, 0xa4ee],
  c: [0x0441, 0x0421, 0x03f2, 0x03f9, 0x1d04, 0x2ca5, 0x2ca4, 0x13df, 0xa4da],
  d: [0x0501, 0x1d05, 0x13a0, 0xa4d3],
  g: [0x0261, 0x0262, 0x0581, 0x050c, 0x13c0, 0xa4d6],
  h: [0x04bb, 0x04ba, 0x043d, 0x041d, 0x0397, 0x0570, 0x029c, 0x13bb, 0xa4e7],
  // Starts with i, I, 1 and |.
  l: [
    0x69, 0x49, 0x31, 0x7c, 0x0456, 0x0406, 0x04cf, 0x04c0, 0x03b9, 0x0399, 0x0269, 0x0131, 0x01c0, 0x026a, 0x029f, 0x13a5,
    0x13de, 0xa4e1, 0xa4f2,
  ],
  m: [0x043c, 0x041c, 0x039c, 0x1d0d, 0x13b7, 0xa4df],
  n: [0x03b7, 0x039d, 0x043f, 0x0578, 0x057c, 0x0274, 0xa4e0],
  // Starts with the digit 0.
  o: [0x30, 0x043e, 0x041e, 0x03bf, 0x039f, 0x0585, 0x0555, 0x1d0f, 0xa4f3],
  r: [0x0433, 0x0280, 0x13a1, 0x13d2, 0xa4e3],
  t: [0x0442, 0x0422, 0x03c4, 0x03a4, 0x1d1b, 0x13a2, 0xa4d4],
  u: [0x057d, 0x054d, 0x03c5, 0x028b, 0x1d1c, 0xa4f4],
};
const AS_LATIN = new Map(
  Object.entries(LOOKALIKES).flatMap(([latin, codes]) => codes.map((c) => [String.fromCodePoint(c), latin] as const)),
);

/** The letters a reader sees: accents dropped, look-alikes read as Latin, "rn" read as "m", lowercase. */
function skeleton(text: string): string {
  const letters = Array.from(text.normalize('NFKD').replace(/\p{M}/gu, ''), (c) => AS_LATIN.get(c) ?? c);
  return letters
    .join('')
    .toLowerCase()
    .replace(/[^\p{L}]/gu, '')
    .replaceAll('rn', 'm');
}

const UNALGORITHM = skeleton('UnAlgorithm');
const CLOUD_WORD = skeleton('Cloud');

/**
 * A name that reads as "UnAlgorithm" and "Cloud" anywhere in it, however it is spaced, ordered, accented or spelled
 * ("unalgorithm  cloud", "Cloud by UnAlgorithm", "cloud.unalgorithm.app", a Cyrillic o in place of the Latin one).
 */
function borrowsCloudName(name: string): boolean {
  const s = skeleton(name);
  return s.includes(UNALGORITHM) && s.includes(CLOUD_WORD);
}

/** Who receives post text from this server, for the flow box (`to`) and the sentence under it. */
export function recipientText(label: ServerLabel): { to: string; text: string } {
  if (label.isCloud) {
    return {
      to: CLOUD,
      text: `Post text goes from your browser to ${CLOUD}, run by HeitechSoft in Canada, which sends it to Anthropic in the United States to classify. ${CLOUD} doesn't log or keep it. ${NEVER_SENT}`,
    };
  }
  const host = label.host || 'your server';
  return {
    to: label.host || label.title,
    text: `Post text goes from your browser to ${host}. That server is run by its owner, not HeitechSoft, and its owner chooses which AI it uses. ${NEVER_SENT}`,
  };
}

/** True when the AI source is the server at `origin`. */
export function isServerAt(cfg: AISourceConfig | null, origin: string): boolean {
  if (cfg?.kind !== 'server') return false;
  try {
    return new URL(cfg.baseUrl).origin === origin;
  } catch {
    return false;
  }
}

/** Tokens must not cross the network in clear, except to a server on this computer. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Where tokens may go and links may point: https, or http to a server on this computer. The one place this rule lives
 * (discovery, and the account page link next to a balance and under the devices).
 */
export function isTrustedServerOrigin(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
}

/** The server's account page, where discovery could have found the server; null anywhere else (no link is offered). */
export function accountPageUrl(origin: string): string | null {
  try {
    const url = new URL(origin);
    return isTrustedServerOrigin(url) ? new URL(ACCOUNT_PAGE_PATH, url.origin).href : null;
  } catch {
    return null;
  }
}
