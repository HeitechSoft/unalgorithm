import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_NAMES } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manifestFor } from '../wxt.config.ts';

/**
 * The Chrome Web Store material (docs/store-listing.md, docs/store/) stays in step with the store manifest and the
 * store's image rules: 1280×800 screenshots (3 to 5), a 440×280 small promo tile and an optional 1400×560 marquee,
 * all 24-bit PNGs without alpha.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const STORE = join(REPO_ROOT, 'docs/store');
const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');
const listing = () => readFileSync(join(REPO_ROOT, 'docs/store-listing.md'), 'utf8').replace(/\r\n/g, '\n');
const messages = () =>
  JSON.parse(readFileSync(join(REPO_ROOT, 'apps/extension/public/_locales/en/messages.json'), 'utf8')) as Record<
    string,
    { message: string }
  >;

/** Width, height, bit depth and colour type from a PNG's IHDR chunk. */
function pngHeader(path: string) {
  const b = readFileSync(path);
  expect(b.subarray(1, 4).toString('latin1'), path).toBe('PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bitDepth: b[24], colorType: b[25] };
}

/** The text of one `### heading` section of the listing. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`### ${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const end = md.indexOf('\n### ', start + 1);
  return md.slice(start, end === -1 ? undefined : end);
}

describe('Chrome Web Store material', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('test_store_images_have_the_store_sizes_without_alpha', () => {
    const pngs = readdirSync(STORE).filter((f) => f.endsWith('.png'));
    const screenshots = pngs.filter((f) => f.startsWith('screenshot-'));
    expect(screenshots.length).toBeGreaterThanOrEqual(3);
    expect(screenshots.length).toBeLessThanOrEqual(5);
    expect(pngs).toContain('promo-small-440x280.png');
    const sizes: Record<string, [number, number]> = {
      'promo-small-440x280.png': [440, 280],
      'promo-marquee-1400x560.png': [1400, 560],
    };
    for (const f of pngs) {
      const [width, height] = sizes[f] ?? [1280, 800];
      // Colour type 2 is truecolour without alpha.
      expect(pngHeader(join(STORE, f)), f).toEqual({ width, height, bitDepth: 8, colorType: 2 });
    }
  });

  it('test_store_listing_names_and_describes_the_product', () => {
    const md = listing();
    const { extName, extDescription } = messages();
    expect(extName?.message).toBe('UnAlgorithm Feed');
    expect(md).toContain(`**${extName?.message}**`);
    expect(md).toContain(`*${extDescription?.message}*`);
    const description = section(md, 'Description');
    expect(description).toContain('```text\nUnAlgorithm Feed by HeitechSoft\n');
    expect(description).toContain('UnAlgorithm Feed is not affiliated with, endorsed by, or sponsored by LinkedIn or Meta.');
  });

  it('test_store_listing_justifies_every_store_permission', () => {
    vi.stubEnv('UA_CLOUD', undefined);
    const store = manifestFor('production');
    const asked = [
      ...(store.permissions ?? []),
      ...(store.host_permissions ?? []),
      ...(store.optional_host_permissions ?? []),
      ...(store.optional_permissions ?? []),
    ];
    const headings = section(listing(), 'Permission justifications')
      .split('\n')
      .filter((line) => line.startsWith('**'));
    for (const permission of asked) {
      expect(
        headings.some((h) => h.includes(`**${permission}**`) || h.includes(`\`${permission}\``)),
        permission,
      ).toBe(true);
    }
    // The store build has no Cloud card, so nothing about the permissions it would add.
    for (const cloudOnly of ['identity', 'alarms']) expect(headings.join(' ')).not.toContain(cloudOnly);
  });

  it('test_store_listing_without_labs', () => {
    // P3-64: Fact-check and UnEcho Chamber left Labs, so no disclosure or doc page names it.
    const docs = [
      'PRIVACY.md',
      'CLOUD-BETA-NOTICE.md',
      'docs/store-listing.md',
      'docs/ai-sources.md',
      'docs/privacy-model.md',
      'docs/site/credits.md',
    ];
    for (const file of docs) expect(read(file), file).not.toMatch(/\bLabs\b/);
  });

  it('test_store_listing_names_unecho_chamber_only_with_a_usable_registry', () => {
    // D79: a listing must not describe a feature the build hides. Store builds have no source list with a lean until the
    // extension reads UnAlgorithm Cloud's (P3-75, P3-77), so UnEcho Chamber stays hidden; P3-77 adds it to the listing.
    expect(listing()).not.toContain(FEATURE_NAMES.perspectives);
  });
});
