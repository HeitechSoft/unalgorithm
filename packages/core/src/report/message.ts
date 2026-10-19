import { BARE_LINK_PATTERN, MAX_CORRECTION_MESSAGE, PROFILE_PATH_PATTERN } from '@unalgorithm/protocol';
import { redact } from '../classify/input.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
// Zero-width characters, soft hyphen, combining grapheme joiner, word joiners, BOM, and bidi marks, embeddings,
// overrides and isolates: they can hide or reorder text in the admin page.
// U+034F is a combining mark, so it is matched on its own rather than inside the class.
const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|\u034F/g;
/**
 * A host of three or more labels with no path, such as "www.example.com" or "jane-doe.substack.com": a subdomain can
 * be someone's name. Each label has two characters or more, so "i.e.the" in a sentence is left alone.
 */
const SUBDOMAIN_HOST =
  /(?<![\p{L}\p{N}_@.-])(?<!\[link: )(?:[\p{L}\p{N}_-]{2,63}\.){2,8}\p{L}{2,24}(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])/gu;
/** A link `redact` or this file already masked, with its host. */
const MASKED_LINK = /\[link: ([^\]\s]+)\]/g;
/** Punctuation that ends a sentence after a link, kept outside the mask. */
const TRAILING = /[.,;:!?)\]'"»”’]+$/u;
/** Second-level names under a country's domain, so "news.bbc.co.uk" is "bbc.co.uk", not "co.uk". */
const SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'gc', 'go', 'gob', 'gouv', 'gov', 'ne', 'net', 'or', 'org']);

/**
 * The site a host belongs to: its last two labels, or three under a country's second level ("bbc.co.uk"). A
 * subdomain ("jane-doe.substack.com", "www.") is dropped, since it can be someone's name. Null for an IP address or a
 * name without a domain, which say nothing about a site.
 */
function siteOf(host: string): string | null {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  const tld = labels[labels.length - 1] ?? '';
  if (labels.length < 2 || !/^(?:\p{L}{2,24}|xn--[a-z0-9-]{1,59})$/u.test(tld)) return null;
  const keep = labels.length > 2 && tld.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2] ?? '') ? 3 : 2;
  return labels.slice(-keep).join('.');
}

const masked = (host: string) => {
  const site = siteOf(host);
  return site ? `[link: ${site}]` : '[link]';
};

/**
 * Every link in `text` as `[link: site]` (ADR 0009 §1: a report never holds a profile or post link). `redact` masks
 * the ones with a scheme; this adds links without one ("linkedin.com/in/jane"), profile and post addresses on their own
 * ("/in/jane", "profile.php?id=…") and hosts with a subdomain, then reduces every masked host to its site.
 */
function maskLinks(text: string): string {
  return (
    text
      // Before the hosts, so "profile.php?id=1" on its own is a link, not the site "profile.php".
      .replace(PROFILE_PATH_PATTERN, (link) => {
        const tail = TRAILING.exec(link)?.[0] ?? '';
        return `[link]${tail}`;
      })
      .replace(BARE_LINK_PATTERN, (link) => {
        const tail = TRAILING.exec(link)?.[0] ?? '';
        return `${masked(link.split(/[/?#]/)[0] ?? '')}${tail}`;
      })
      .replace(SUBDOMAIN_HOST, (host) => {
        const site = siteOf(host);
        return site && site !== host.toLowerCase() ? `[link: ${site}]` : host;
      })
      .replace(MASKED_LINK, (_link, host: string) => masked(host))
  );
}

/**
 * A correction's own words, made safe to send (ADR 0009 §2): NFKC; control characters but the newline removed; zero-
 * width and bidi characters removed; emails and phone numbers masked and @handles made `@someone` (`redact`); every
 * link, with a scheme or not, reduced to its site (`[link: example.org]`), and a profile or post address on its own to
 * `[link]`; spaces and blank lines collapsed; trimmed; at most MAX_CORRECTION_MESSAGE characters (UTF-16 code units, as
 * `String.length` and the wire schema count them, never splitting a character). The server cleans it again.
 *
 * The report page shows the result as the person types. It trims, so it belongs in the preview and the body, never
 * written back into the text field (a space typed at the end would vanish).
 */
export function cleanReportMessage(text: string): string {
  let t = text.normalize('NFKC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(CONTROL, '').replace(INVISIBLE, '');
  t = maskLinks(redact(t, { mentions: true }));
  t = t
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length <= MAX_CORRECTION_MESSAGE) return t;
  let end = MAX_CORRECTION_MESSAGE;
  // Never end on the first half of a surrogate pair.
  const last = t.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return t.slice(0, end).trimEnd();
}
