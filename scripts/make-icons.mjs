#!/usr/bin/env node
/**
 * Renders the UnAlgorithm mark ("U" holding a dot) to PNG icons with headless Chromium:
 *   apps/extension/public/icon/{16,32,48,128}.png and paused-{16,32}.png (greyscale).
 * 16 px is drawn flat with thicker strokes for toolbar legibility; 128 px keeps Chrome's 16 px transparent padding.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(join(import.meta.dirname, '..', 'apps', 'extension', 'package.json'));
const { chromium } = require('@playwright/test');

const OUT = join(import.meta.dirname, '..', 'apps', 'extension', 'public', 'icon');
mkdirSync(OUT, { recursive: true });

function svg({ size, inset = 0, flat = false, grey = false }) {
  const top = grey ? '#a1a1aa' : '#14B8A6';
  const bottom = grey ? '#71717a' : '#0B7A75';
  const art = size - inset * 2;
  const stroke = flat ? 8.5 : 6.5;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
  <g transform="translate(${inset} ${inset}) scale(${art / 64})">
    <rect width="64" height="64" rx="${flat ? 13 : 15}" fill="${flat ? bottom : 'url(#g)'}"/>
    ${flat ? '' : '<rect x="0.5" y="0.5" width="63" height="63" rx="14.5" fill="none" stroke="#fff" stroke-opacity=".18"/>'}
    <path d="M20 ${flat ? 15 : 17}v${flat ? 17 : 16}a12 12 0 0 0 24 0V${flat ? 15 : 17}" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round"/>
    <circle cx="32" cy="${flat ? 31 : 32}" r="${flat ? 6 : 5}" fill="${grey ? '#e4e4e7' : '#D0F3EE'}"/>
  </g></svg>`;
}

const variants = [
  { name: '16', size: 16, flat: true },
  { name: '32', size: 32, flat: true },
  { name: '48', size: 48, inset: 2 },
  { name: '128', size: 128, inset: 16 },
  { name: 'paused-16', size: 16, flat: true, grey: true },
  { name: 'paused-32', size: 32, flat: true, grey: true },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const v of variants) {
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(v)}</body></html>`);
  await page.locator('svg').screenshot({
    path: join(OUT, v.name.startsWith('paused-') ? `../paused/${v.name.slice(7)}.png` : `${v.name}.png`),
    omitBackground: true,
  });
  console.log(`icon/${v.name}.png`);
}
await browser.close();
