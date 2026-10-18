import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_NAMES, FIREFOX_ADDON_ID } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REVIEWED_WARNINGS } from '../../../scripts/check-firefox-lint.mjs';
import { FIREFOX_MIN_VERSION, manifestFor } from '../wxt.config.ts';

/**
 * The store material stays in step with each store build's manifest and with each other: the Chrome Web Store's
 * (docs/store-listing.md, docs/store/, whose image rules are 1280×800 screenshots (3 to 5), a 440×280 small promo tile
 * and an optional 1400×560 marquee, all 24-bit PNGs without alpha), Microsoft Edge Add-ons' (docs/store-listing-edge.md)
 * and Firefox Add-ons' (docs/store-listing-firefox.md, and docs/amo-build.md in the sources zip) (ADR 0008).
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const STORE = join(REPO_ROOT, 'docs/store');
const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');
const doc = (file: string) => read(file).replace(/\r\n/g, '\n');
const listing = () => doc('docs/store-listing.md');
const edgeListing = () => doc('docs/store-listing-edge.md');
const firefoxListing = () => doc('docs/store-listing-firefox.md');
const oneLine = (text: string) => text.replace(/\s+/g, ' ');
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

/** The lines of the first fenced text block in a section: the paste-ready text. */
function pasteText(md: string, heading: string): string[] {
  const text = section(md, heading).split('```text\n')[1]?.split('\n```')[0];
  expect(text, heading).toBeDefined();
  return (text ?? '').split('\n');
}

/** Every permission a manifest asks for, required or optional. */
function askedPermissions(manifest: ReturnType<typeof manifestFor>): string[] {
  return [
    ...(manifest.permissions ?? []),
    ...(manifest.host_permissions ?? []),
    ...(manifest.optional_host_permissions ?? []),
    ...(manifest.optional_permissions ?? []),
  ];
}

/** The bold headings (`**name**`) of a listing section, as a permission justification starts. */
function boldHeadings(md: string, heading: string): string[] {
  return section(md, heading)
    .split('\n')
    .filter((line) => line.startsWith('**'));
}

const covers = (headings: string[], permission: string) =>
  headings.some((h) => h.includes(`**${permission}**`) || h.includes(`\`${permission}\``));

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
    const headings = boldHeadings(listing(), 'Permission justifications');
    for (const permission of askedPermissions(manifestFor('production', 'chrome'))) {
      expect(covers(headings, permission), permission).toBe(true);
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
      'docs/store-listing-edge.md',
      'docs/store-listing-firefox.md',
      'docs/ai-sources.md',
      'docs/privacy-model.md',
      'docs/site/credits.md',
    ];
    for (const file of docs) expect(read(file), file).not.toMatch(/\bLabs\b/);
  });

  it('test_store_listing_describes_unecho_chamber', () => {
    // D103 (reverses D79): every build shows UnEcho Chamber, so every store's listing describes it, with what it sends.
    const sends = "the shared link, its title and the chosen source list's web addresses and leans (UnEcho Chamber)";
    for (const md of [listing(), edgeListing(), firefoxListing()]) {
      const description = section(md, 'Description');
      expect(description).toContain('FACT-CHECK AND UNECHO CHAMBER (OFF BY DEFAULT)');
      expect(description).not.toContain('FACT-CHECK (OFF BY DEFAULT)');
      expect(description).toContain(
        `• ${FEATURE_NAMES.perspectives}: on a public post that shares a news link, see how outlets across the spectrum covered the story, sorted by unAlgorithm Cloud's source list or your own.`,
      );
    }
    // Chrome's data-use answer, which Edge's listing points to, and Firefox's data-collection type say what it sends.
    expect(oneLine(section(listing(), 'Data usage'))).toContain(sends);
    expect(oneLine(section(firefoxListing(), 'Data collection'))).toContain(sends);

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
    // The other stores answer the same, and their reviewers read it in the notes.
    for (const [other, notes] of [
      [edgeListing(), 'Notes for certification'],
      [firefoxListing(), 'Notes for Reviewers'],
    ] as const) {
      expect(oneLine(section(other, 'Remote code'))).toContain(
        "unAlgorithm Cloud's published source list is JSON data, never run as code.",
      );
      expect(oneLine(section(other, notes))).toContain('at most once a day');
    }
  });
});

/** The Chrome description's lines that name neither Chrome nor its side panel: the ones every store repeats. */
function sharedLines(): string[] {
  return pasteText(listing(), 'Description').filter((line) => line.trim() && !/Chrome|side panel/.test(line));
}

describe('Microsoft Edge Add-ons material', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('test_edge_listing_follows_the_chrome_manifest', () => {
    // Partner Center gets Chrome's answers word for word, which holds only while the Edge build has Chrome's manifest.
    for (const cloud of [undefined, '1']) {
      vi.stubEnv('UA_CLOUD', cloud);
      expect(manifestFor('production', 'edge'), String(cloud)).toEqual(manifestFor('production', 'chrome'));
    }
    const md = edgeListing();
    expect(md).toContain('[store-listing.md](store-listing.md#privacy-practices-tab)');
    expect(listing()).toContain('## Privacy practices tab');
    expect(md).toContain(`**${messages().extName?.message}**`);
    expect(oneLine(section(md, 'Notes for certification'))).toContain('loads no remote code');
  });

  it('test_edge_description_repeats_chrome_and_names_edge_ai', () => {
    const lines = pasteText(edgeListing(), 'Description');
    expect(lines[0]).toBe('unAlgorithm Feed by HeitechSoft');
    expect(lines).toContain('unAlgorithm Feed is not affiliated with, endorsed by, or sponsored by LinkedIn or Meta.');
    for (const line of sharedLines()) expect(lines, line).toContain(line);
    // Edge's own built-in AI, as a preview; never Chrome's.
    expect(lines.join('\n')).not.toMatch(/Chrome/);
    expect(lines.some((line) => line.startsWith("• Edge's built-in AI") && line.includes('preview'))).toBe(true);
  });
});

describe('Firefox Add-ons material', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('test_firefox_listing_explains_every_permission', () => {
    vi.stubEnv('UA_CLOUD', undefined);
    const store = manifestFor('production', 'firefox');
    const headings = boldHeadings(firefoxListing(), 'Permissions');
    for (const permission of askedPermissions(store)) expect(covers(headings, permission), permission).toBe(true);
    // Not in the Firefox build: Chrome's injection and side panel, and the Cloud card's permissions.
    for (const absent of ['scripting', 'sidePanel', 'identity', 'alarms']) {
      expect(askedPermissions(store), absent).not.toContain(absent);
      expect(headings.join(' '), absent).not.toContain(absent);
    }
  });

  it('test_firefox_listing_matches_id_version_and_data_collection', () => {
    vi.stubEnv('UA_CLOUD', undefined);
    const gecko = manifestFor('production', 'firefox').browser_specific_settings?.gecko as
      | { id?: string; strict_min_version?: string; data_collection_permissions?: { required?: string[]; optional?: string[] } }
      | undefined;
    const md = firefoxListing();
    expect(gecko?.id).toBe(FIREFOX_ADDON_ID);
    expect(md).toContain(`\`${FIREFOX_ADDON_ID}\``);
    expect(gecko?.strict_min_version).toBe(FIREFOX_MIN_VERSION);
    // The listing and the install instructions name the same minimum.
    const major = FIREFOX_MIN_VERSION.replace(/\.0$/, '');
    expect(md).toContain(`Firefox ${major}`);
    for (const file of ['README.md', 'CONTRIBUTING.md']) expect(oneLine(read(file)), file).toContain(`Firefox ${major} or newer`);
    // One row per declared type, under the key that declares it: the table's first two cells, without backticks.
    const keyAndType = (row: string) =>
      row
        .split('|')
        .slice(1, 3)
        .map((cell) => cell.trim().replaceAll('`', ''));
    // The store build's table first, then the types a build with the server card adds (one per row, by its first cell).
    const [store = '', withCloud = ''] = section(md, 'Data collection').split('**With the server card**');
    const rows = (text: string) => text.split('\n').filter((line) => line.startsWith('| `'));
    const declared = [
      ...(gecko?.data_collection_permissions?.required ?? []).map((type) => ['required', type]),
      ...(gecko?.data_collection_permissions?.optional ?? []).map((type) => ['optional', type]),
    ];
    expect(declared).toEqual([
      ['required', 'none'],
      ['optional', 'websiteContent'],
      ['optional', 'personalCommunications'],
    ]);
    expect(rows(store).map(keyAndType)).toEqual(declared);
    vi.stubEnv('UA_CLOUD', '1');
    const cloud = manifestFor('production', 'firefox').browser_specific_settings?.gecko as typeof gecko;
    const added = (cloud?.data_collection_permissions?.optional ?? []).filter(
      (type) => !gecko?.data_collection_permissions?.optional?.includes(type),
    );
    expect(added).toEqual(['personallyIdentifyingInfo', 'authenticationInfo', 'technicalAndInteraction']);
    expect(cloud?.data_collection_permissions?.required).toEqual(['none']);
    expect(rows(withCloud).map((row) => row.split('|')[1]?.trim().replaceAll('`', ''))).toEqual(added);
  });

  it('test_firefox_description_repeats_chrome_without_built_in_ai', () => {
    const lines = pasteText(firefoxListing(), 'Description');
    expect(lines[0]).toBe('unAlgorithm Feed by HeitechSoft');
    expect(lines).toContain('unAlgorithm Feed is not affiliated with, endorsed by, or sponsored by LinkedIn or Meta.');
    for (const line of sharedLines()) expect(lines, line).toContain(line);
    // Firefox has no built-in AI for extensions, and Highlights is in its sidebar.
    expect(lines.join('\n')).not.toMatch(/Chrome|built-in AI|side panel/);
    expect(lines.join('\n')).toContain('sidebar');
  });

  it('test_amo_build_doc_gives_the_exact_build', () => {
    // docs/amo-build.md travels in the sources zip: the commands, the tool versions and the linter's warnings.
    const build = doc('docs/amo-build.md');
    const pkg = JSON.parse(read('package.json')) as { packageManager: string };
    expect(build).toContain(`pnpm ${pkg.packageManager.replace('pnpm@', '')}`);
    expect(build).toContain(`Node.js ${read('.nvmrc').trim()}`);
    for (const command of [
      'corepack enable',
      'pnpm install --frozen-lockfile',
      'pnpm --filter @unalgorithm/extension exec wxt build -b firefox',
      'UA_CLOUD=1 pnpm --filter @unalgorithm/extension exec wxt build -b firefox',
    ]) {
      expect(build, command).toContain(command);
    }
    // Every reviewed warning is explained, and the reviewer notes name each one too.
    const notes = section(firefoxListing(), 'Notes for Reviewers');
    for (const { code } of REVIEWED_WARNINGS) {
      expect(build, code).toContain(`\`${code}\``);
      expect(notes, code).toContain(code);
    }
  });
});
