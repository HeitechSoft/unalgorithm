#!/usr/bin/env node
/**
 * Fails if a captured fixture (packages/platforms/fixtures/**\/*.html) contains text that looks unscrambled: any
 * word of four or more letters that is not made of the scrambler's x/X characters and is not a known UI label.
 * Captured fixtures must never contain real names or post text.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = process.argv[2] ? resolve(process.argv[2]) : join(import.meta.dirname, '..', 'packages', 'platforms', 'fixtures');

/** Route words, hosts and static ids that may appear in the attribute values the capture scripts keep. */
const ATTR_ALLOW = new Set(
  `https http www linkedin facebook example article company school showcase groups events posts pulse feed update
  hashtag activity ugcpost share newsletters jobs search video embed mynetwork products services learning permalink
  story fbid user reel reels videos watch photo photos stories about marketplace gaming pages media expandable text
  button main comment list commentlist card focus full unit`
    .split(/\s+/)
    .filter(Boolean),
);

/** Words a reader would see, or that could identify someone: labels, and links and test ids split into words. */
function attributeWords(tag) {
  const out = [];
  for (const [, name, value] of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    if (name === 'aria-label' || name === 'title' || name === 'alt') out.push(value);
    else if (['href', 'data-testid', 'data-view-name', 'componentkey', 'data-pagelet'].includes(name))
      out.push(
        ...decodeURIComponent(value.replace(/%(?![0-9a-f]{2})/gi, '%25'))
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .split(/[^\p{L}]+/u)
          .filter((w) => w && !ATTR_ALLOW.has(w.toLowerCase())),
      );
  }
  return out.join(' ');
}
const ALLOW = new Set(
  `sponsored promoted suggested follow following join request more like comment repost send share likes commented
  this reposted followed celebrates supports loves finds insightful feed post open control menu hide view group
  people know edited reaction button state paid partnership reels short videos stories learn shop sign public
  friends shared with friend reacted posts groups pages your about apply book download contact subscribe watch
  order install donate listen play game event events marketplace today picks may`
    .split(/\s+/)
    .filter(Boolean),
);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (p.endsWith('.html')) yield p;
  }
}

let problems = 0;
for (const file of files(ROOT)) {
  const html = readFileSync(file, 'utf8');
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, (tag) => ` ${attributeWords(tag)} `)
    .replace(/&[a-z]+;/g, ' ');
  const leaks = new Set();
  for (const word of text.match(/\p{L}+/gu) ?? []) {
    if (/^[xX]+$/.test(word)) continue;
    if (ALLOW.has(word.toLowerCase())) continue;
    // Short English words can't identify anyone, but any non-ASCII letter means the scrambler missed something
    // (names in other scripts are often one to three characters long).
    if (word.length >= 4 || /[^A-Za-z]/.test(word)) leaks.add(word);
  }
  if (leaks.size) {
    problems++;
    console.error(`${relative(process.cwd(), file)}: ${leaks.size} unscrambled word(s): ${[...leaks].slice(0, 12).join(', ')}`);
  }
}
if (problems) {
  console.error('\nCaptured fixtures must be anonymized. Re-run the capture script or scramble these words.');
  process.exit(1);
}
console.log('fixtures:check ok');
