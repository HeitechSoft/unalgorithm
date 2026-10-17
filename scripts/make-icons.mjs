#!/usr/bin/env node
/**
 * Renders the unAlgorithm mark ("U" holding a dot) to PNG icons with headless Chromium:
 *   apps/extension/public/icon/{16,32,48,128}.png and paused-{16,32}.png (greyscale).
 * 16 px is drawn flat with thicker strokes for toolbar legibility; 128 px keeps Chrome's 16 px transparent padding.
 *
 * With --store, renders the Chrome Web Store promo tiles from the same drawing instead, into docs/store/:
 *   promo-small-440x280.png (required) and promo-marquee-1400x560.png. The store screenshots come from
 *   apps/extension/e2e/store.spec.ts (`pnpm --filter @unalgorithm/extension store:screens`).
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(join(import.meta.dirname, '..', 'apps', 'extension', 'package.json'));
const { chromium } = require('@playwright/test');

const OUT = join(import.meta.dirname, '..', 'apps', 'extension', 'public', 'icon');
const STORE_OUT = join(import.meta.dirname, '..', 'docs', 'store');

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

// Store artwork: Lagoon on the light ramp (docs/brand.md, packages/ui/src/styles/tokens.css).
const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI", system-ui, Roboto, Arial, sans-serif`;
const INK = '#1d1d1f';
const MUTED = '#5e5e63';
const LAGOON = '#0b7a75';
const TAGLINE = 'See the posts you came for.';

/** The wordmark (un in Lagoon, Algorithm in ink), followed by "Feed" so the artwork names the product in full. */
function wordmark(size) {
  return `<div style="font-size:${size}px;font-weight:600;line-height:1;letter-spacing:-0.02em;white-space:nowrap">
    <span style="color:${LAGOON};font-weight:700">un</span><span style="color:${INK}">Algorithm</span><span style="color:${INK};font-weight:400"> Feed</span>
  </div>`;
}

/** An abstract feed: a post picked for you, the noise folded into thin lines, and a post that stays. */
function feedArt() {
  const bar = (x, y, w, fill = '#d9dee1') => `<rect x="${x}" y="${y}" width="${w}" height="10" rx="5" fill="${fill}"/>`;
  const folded = (y, w) => `<g transform="translate(0 ${y})">
    <rect width="520" height="52" rx="12" fill="#fff" stroke="#000" stroke-opacity=".06"/>
    <path d="M12 22v-6M12 8V2M4 12H2M10 12H8M16 12h-2M22 12h-2M15 19l-3-3-3 3M15 5l-3 3-3-3" fill="none" stroke="#8e8e93" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="translate(22 14)"/>
    ${bar(56, 21, 64, '#c7cdd1')}<rect x="134" y="16" width="${w}" height="20" rx="10" fill="#eef0f1"/>${bar(444, 21, 48, '#9fd8d1')}
  </g>`;
  const post = (y, pick) => `<g transform="translate(0 ${y})">
    <rect width="520" height="${pick ? 156 : 124}" rx="14" fill="#fff" ${pick ? `stroke="${LAGOON}" stroke-width="2.5"` : 'stroke="#000" stroke-opacity=".06"'}/>
    <circle cx="44" cy="44" r="20" fill="#d5dde1"/>${bar(76, 30, 132, '#b9c2c7')}${bar(76, 48, 92)}
    ${bar(24, 80, 448)}${bar(24, 98, 360)}
    ${pick ? `<line x1="24" y1="122" x2="496" y2="122" stroke="#000" stroke-opacity=".07"/><circle cx="32" cy="140" r="5" fill="${LAGOON}"/><text x="46" y="145" font-size="15" font-weight="600" fill="${LAGOON}">For you</text>` : ''}
  </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="484" height="412" viewBox="-4 -4 528 448">
    ${post(0, true)}${folded(170, 96)}${post(236, false)}${folded(374, 132)}
  </svg>`;
}

const tiles = [
  {
    name: 'promo-small-440x280',
    width: 440,
    height: 280,
    body: `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;height:100%">
      ${svg({ size: 76 })}
      ${wordmark(36)}
      <div style="font-size:18px;color:${MUTED}">${TAGLINE}</div>
    </div>`,
  },
  {
    name: 'promo-marquee-1400x560',
    width: 1400,
    height: 560,
    body: `<div style="display:flex;align-items:center;justify-content:space-between;height:100%;padding:0 112px 0 120px">
      <div>
        <div style="display:flex;align-items:center;gap:20px">${svg({ size: 72 })}${wordmark(44)}</div>
        <div style="margin-top:40px;font-size:46px;font-weight:700;line-height:1.1;letter-spacing:-0.02em;color:${INK}">${TAGLINE}</div>
        <div style="margin-top:18px;max-width:560px;font-size:22px;line-height:1.45;color:${MUTED}">Folds away ads, suggested posts and other noise. Every fold shows why, and one click brings a post back.</div>
      </div>
      ${feedArt()}
    </div>`,
  },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
if (process.argv.includes('--store')) {
  mkdirSync(STORE_OUT, { recursive: true });
  for (const t of tiles) {
    await page.setViewportSize({ width: t.width, height: t.height });
    await page.setContent(
      `<html><head><style>body { margin: 0; width: ${t.width}px; height: ${t.height}px; overflow: hidden; font-family: ${FONT}; background: linear-gradient(160deg, #ecfaf8 0%, #d0f3ee 100%); }</style></head><body>${t.body}</body></html>`,
    );
    await page.screenshot({ path: join(STORE_OUT, `${t.name}.png`) });
    console.log(`docs/store/${t.name}.png`);
  }
} else {
  mkdirSync(OUT, { recursive: true });
  for (const v of variants) {
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg(v)}</body></html>`);
    await page.locator('svg').screenshot({
      path: join(OUT, v.name.startsWith('paused-') ? `../paused/${v.name.slice(7)}.png` : `${v.name}.png`),
      omitBackground: true,
    });
    console.log(`icon/${v.name}.png`);
  }
}
await browser.close();
