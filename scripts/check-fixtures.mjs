#!/usr/bin/env node
/**
 * Fails if a captured fixture (packages/platforms/fixtures/**\/*.html, or the file or folder given) contains text that
 * looks unscrambled: any word of four or more letters that is not made of the scrambler's x/X characters and is not a
 * known UI label. Captured fixtures must never contain real names or post text.
 *
 * Also fails on anything that came from a problem report a user sent (ADR 0009 §9): a report is never committed,
 * attached to an issue or published, so a file carrying a report's comment or unAlgorithm's own state attribute is
 * refused, whatever else it holds.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = process.argv[2] ? resolve(process.argv[2]) : join(import.meta.dirname, '..', 'packages', 'platforms', 'fixtures');

/** Route words, hosts and static ids that may appear in the attribute values the capture scripts keep. */
const ATTR_ALLOW = new Set(
  `https http www linkedin facebook example article company school showcase groups events posts pulse feed update
  hashtag activity ugcpost share newsletters jobs search video embed mynetwork messaging notifications products services
  learning permalink story fbid user reel reels videos watch photo photos stories about marketplace gaming pages media
  expandable text button main comment list commentlist card focus full unit profile friends bookmarks messages right
  rail container type relevance recency`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * React's generated ids (`_r_2gl_`, `_R_3aqm…_`, `:r1:`, `«r1»`, base 32): opaque, never a word anyone wrote. Older
 * captures kept them; the capture scripts now replace every id with a fake.
 */
const REACT_ID = /^(_[rR]_[0-9a-v]+_|:[rR][0-9a-v]+:|«[rR][0-9a-v]+»)$/;

/** Attributes whose values are split into words and checked: links, test ids, keys and the ids labels point at. */
const SPLIT_ATTRS = [
  'href',
  'xlink:href',
  'data-testid',
  'data-view-name',
  'data-sdui-screen',
  'componentkey',
  'data-pagelet',
  'id',
  'aria-labelledby',
  'aria-describedby',
];

/** Words a reader would see, or that could identify someone: labels, and links, test ids and ids split into words. */
function attributeWords(tag) {
  const out = [];
  for (const [, name, value] of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    if (name === 'aria-label' || name === 'title' || name === 'alt') out.push(value);
    else if (SPLIT_ATTRS.includes(name))
      out.push(
        ...value
          .split(/\s+/)
          .filter((token) => !REACT_ID.test(token))
          .flatMap((token) =>
            decodeURIComponent(token.replace(/%(?![0-9a-f]{2})/gi, '%25'))
              .replace(/([a-z])([A-Z])/g, '$1 $2')
              .split(/[^\p{L}]+/u),
          )
          .filter((w) => w && !ATTR_ALLOW.has(w.toLowerCase())),
      );
  }
  return out.join(' ');
}

/** UI labels a capture keeps, besides every word the capture scripts' KEEP lists keep (read below). */
const ALLOW = new Set(
  `sponsored promoted suggested follow following join request more like comment repost send share likes commented
  this reposted followed celebrates supports loves finds insightful feed post open control menu hide view group
  people know edited reaction button state paid partnership reels short videos stories learn shop sign public
  friends shared with friend reacted posts groups pages your about apply book download contact subscribe watch
  order install donate listen play game event events marketplace today picks may`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * The capture scripts' KEEP lists: a word they keep on purpose is a label, never a leak. Read from the scripts so the
 * two can't drift apart (the capture-vocab test checks the lists themselves against the adapters' markers).
 */
const KEEP = ['linkedin.js', 'facebook.js'].map((file) => {
  const source = readFileSync(join(import.meta.dirname, 'capture', file), 'utf8');
  const literal = /const KEEP =\s*\/(.+)\/([a-z]*);/.exec(source);
  if (!literal) throw new Error(`check-fixtures: cannot read KEEP from scripts/capture/${file}`);
  return new RegExp(literal[1], literal[2]);
});
const allowed = (word) => ALLOW.has(word.toLowerCase()) || KEEP.some((keep) => keep.test(word));

/**
 * Signs that a file came from a problem report rather than a capture: a comment that names a report or carries a
 * report reference (`7KQ3-M2PA`), or unAlgorithm's own state on the page's elements.
 */
const REPORT_COMMENT = /<!--(?:(?!-->)[\s\S])*?\b(report|[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\b[\s\S]*?-->/i;
const REPORT_STATE = /\sdata-ua-state[\s=>]/;

function* files(path) {
  if (statSync(path).isFile()) {
    if (path.endsWith('.html')) yield path;
    return;
  }
  for (const name of readdirSync(path)) yield* files(join(path, name));
}

let problems = 0;
for (const file of files(ROOT)) {
  const html = readFileSync(file, 'utf8');
  const name = relative(process.cwd(), file);
  const report = REPORT_COMMENT.exec(html)?.[0] ?? (REPORT_STATE.test(html) ? 'data-ua-state' : null);
  if (report) {
    problems++;
    console.error(`${name}: looks like a problem report a user sent (${report.slice(0, 60)}). Reports are never committed.`);
    continue;
  }
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, (tag) => ` ${attributeWords(tag)} `)
    .replace(/&[a-z]+;/g, ' ');
  const leaks = new Set();
  for (const word of text.match(/\p{L}+/gu) ?? []) {
    if (/^[xX]+$/.test(word)) continue;
    if (allowed(word)) continue;
    // Short English words can't identify anyone, but any non-ASCII letter means the scrambler missed something
    // (names in other scripts are often one to three characters long).
    if (word.length >= 4 || /[^A-Za-z]/.test(word)) leaks.add(word);
  }
  if (leaks.size) {
    problems++;
    console.error(`${name}: ${leaks.size} unscrambled word(s): ${[...leaks].slice(0, 12).join(', ')}`);
  }
}
if (problems) {
  console.error(
    '\nCaptured fixtures must be anonymized. Re-run the capture script or scramble these words; never commit a report.',
  );
  process.exit(1);
}
console.log('fixtures:check ok');
