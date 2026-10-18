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
    expect(extName?.message).toBe('unAlgorithm Feed');
    expect(md).toContain(`**${extName?.message}**`);
    expect(md).toContain(`*${extDescription?.message}*`);
    const description = section(md, 'Description');
    expect(description).toContain('```text\nunAlgorithm Feed by HeitechSoft\n');
    expect(description).toContain('unAlgorithm Feed is not affiliated with, endorsed by, or sponsored by LinkedIn or Meta.');
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

  it('test_store_listing_describes_unecho_chamber', () => {
    // D103 (reverses D79): every build shows UnEcho Chamber, so the listing describes it, with what it sends.
    const oneLine = (text: string) => text.replace(/\s+/g, ' ');
    const md = listing();
    const description = section(md, 'Description');
    expect(description).toContain('FACT-CHECK AND UNECHO CHAMBER (OFF BY DEFAULT)');
    expect(description).not.toContain('FACT-CHECK (OFF BY DEFAULT)');
    expect(description).toContain(
      `• ${FEATURE_NAMES.perspectives}: on a public post that shares a news link, see how outlets across the spectrum covered the story, sorted by unAlgorithm Cloud's source list or your own.`,
    );
    expect(oneLine(section(md, 'Data usage'))).toContain(
      "the shared link, its title and the chosen source list's web addresses and leans (UnEcho Chamber)",
    );

    // PRIVACY.md says what a comparison sends a server, that it is never kept, and where leans come from.
    const privacy = read('PRIVACY.md').replace(/\r\n/g, '\n');
    const paragraph = (start: string) => oneLine(privacy.split(/\n\n/).find((p) => p.startsWith(start)) ?? '');
    const ownKey = paragraph('**UnEcho Chamber (off by default');
    const server = paragraph('**UnEcho Chamber on your unAlgorithm server');
    expect(ownKey).toContain("the outlets your chosen source list gives a lean (unAlgorithm Cloud's list or your own)");
    expect(ownKey).toContain(
      "Lean labels come only from unAlgorithm Cloud's source list, set by its admins with evidence, or from your own list, never from the AI.",
    );
    expect(server).toContain("your chosen list's outlets with a lean, as web addresses and leans without names");
    expect(server).toContain('never stored or logged');
    expect(server).toContain('This browser shows a result only when every lean in it matches the list it sent.');
    expect(oneLine(privacy)).toContain('your own list, never from the AI');
    expect(privacy).not.toMatch(/reviewed outlet list|our outlet list/);
  });

  it('test_privacy_and_listing_describe_source_list_fetch', () => {
    // P3-75 (D98): the one request every extension makes while UnEcho Chamber is on, disclosed in the same change.
    const oneLine = (text: string) => text.replace(/\s+/g, ' ');
    const privacy = oneLine(read('PRIVACY.md'));
    for (const phrase of [
      'at most once a day',
      'cloud.unalgorithm.app',
      'no account, cookie or sign-in',
      'never your IP address',
    ]) {
      expect(privacy, phrase).toContain(phrase);
    }
    const md = listing();
    expect(oneLine(section(md, 'Remote code'))).toContain(
      "unAlgorithm Cloud's published source list is JSON data, never run as code.",
    );
    expect(oneLine(section(md, 'Data usage'))).toContain(
      "downloads unAlgorithm Cloud's public source list at most once a day; the request carries no user data.",
    );
  });
});
