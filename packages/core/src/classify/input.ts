import { MAX_POST_CHARS, type PostForAI } from '@unalgorithm/protocol';
import { cyrb53 } from '../hash.ts';
import type { PostData } from '../post.ts';
import { canonicalText } from './fence.ts';

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const PHONE = /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\w)|\+\d{2,3}(?:[\s-]?\d{2,4}){3,5}(?!\w)/g;
// "@jane.doe" is one handle, but the full stop in "thanks @bob." ends the sentence.
const HANDLE = /(?<![\w@])@[\p{L}\p{N}_]{2,}(?:\.[\p{L}\p{N}_]+)*/gu;
const URL_RE = /\bhttps?:\/\/\S+/gi;

/** Mask personal details in post text before it leaves the device. */
export function redact(text: string, opts: { mentions: boolean }): string {
  const t = redactContacts(text);
  return opts.mentions ? t.replace(HANDLE, '@someone') : t;
}

/** Emails, phone numbers and web addresses: always masked, whatever the settings. */
function redactContacts(text: string): string {
  return text
    .replace(EMAIL, '[email]')
    .replace(PHONE, '[phone]')
    .replace(URL_RE, (u) => {
      try {
        return `[link: ${new URL(u).hostname}]`;
      } catch {
        return '[link]';
      }
    });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces whole-word occurrences of each name (longest first, so "Jane Doe" wins over "Jane"). */
function maskNames(text: string, names: ReadonlyArray<readonly [name: string, replacement: string]>): string {
  let t = text;
  for (const [name, replacement] of [...names].sort((a, b) => b[0].length - a[0].length)) {
    t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(name)}(?![\\p{L}\\p{N}_])`, 'gu'), replacement);
  }
  return t;
}

export interface ToPostForAIOptions {
  ref: string;
  maxChars?: number;
  redactMentions: boolean;
}

/**
 * The only function that turns a post into something an AI may see. No author name, URL, group name, comments
 * or images: just normalized text (capped), the media kind, the shared link's domain and title, and the
 * author's kind (person or page).
 */
export function toPostForAI(post: PostData, opts: ToPostForAIOptions): PostForAI {
  const max = Math.min(opts.maxChars ?? MAX_POST_CHARS, MAX_POST_CHARS);
  // Everything is compared in canonical form, the form the model will see.
  let text = redactContacts(canonicalText(post.text));
  const names: Array<readonly [string, string]> = [];
  // The author's own name, if the platform echoed it into the text.
  const author = canonicalText(post.author.name ?? '').trim();
  if (author.length > 2) names.push([author, 'the author']);
  // Tagged people appear as plain linked names (no "@"), so the adapter lists them and they are masked here.
  if (opts.redactMentions) {
    for (const n of post.mentions ?? []) {
      const name = canonicalText(n).trim();
      if (name.length > 1 && name !== author) names.push([name, '@someone']);
    }
  }
  text = maskNames(text, names);
  if (opts.redactMentions) text = text.replace(HANDLE, '@someone');
  const truncated = text.length > max;
  if (truncated) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return {
    ref: opts.ref,
    platform: post.platform,
    text,
    textComplete: post.textComplete && !truncated,
    ...(post.lang ? { lang: post.lang } : {}),
    authorKind: post.author.kind,
    isReshare: post.signals.reshare,
    media: post.media,
    ...(post.sharedLink
      ? {
          link: {
            domain: post.sharedLink.domain,
            ...(post.sharedLink.title ? { title: post.sharedLink.title.slice(0, 300) } : {}),
          },
        }
      : {}),
    // Never rendered into a prompt; lets a server refuse posts that are not public.
    ...(post.platform === 'facebook' ? { audience: post.audience ?? 'unknown' } : {}),
  };
}

/** Hash of exactly what the AI sees for a post; part of the cache key, so edited posts are re-classified. */
export function inputHash(p: PostForAI): string {
  return cyrb53(
    [p.text, p.textComplete, p.media, p.isReshare, p.authorKind, p.link?.domain ?? '', p.link?.title ?? ''].join('\u0000'),
  );
}
