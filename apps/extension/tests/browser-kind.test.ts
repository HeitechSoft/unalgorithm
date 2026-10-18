/**
 * Which browser runs the extension (ADR 0008): Firefox from the build, Chrome or Edge from the brand names, since Edge
 * users can install the Chrome Web Store build. Vitest builds for Chrome, so the Firefox facts are passed in.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { brandNames, browserKind, browserLabel, browserVersion } from '../src/lib/browser-kind.ts';

const CHROME_BRANDS = ['Not)A;Brand', 'Chromium', 'Google Chrome'];
const EDGE_BRANDS = ['Not=A?Brand', 'Chromium', 'Microsoft Edge'];

function stubBrands(brands: string[] | undefined) {
  Object.defineProperty(navigator, 'userAgentData', {
    value: brands && { brands: brands.map((brand) => ({ brand, version: '141' })), mobile: false, platform: 'Windows' },
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'userAgentData');
});

describe('browser kind', () => {
  it('test_browser_kind_from_build_and_brands', () => {
    expect(browserKind({ firefox: false, brands: CHROME_BRANDS })).toBe('chrome');
    expect(browserKind({ firefox: false, brands: EDGE_BRANDS })).toBe('edge');
    // Other Chromium browsers run the Chrome build.
    expect(browserKind({ firefox: false, brands: ['Chromium', 'Opera'] })).toBe('chrome');
    expect(browserKind({ firefox: false, brands: ['Brave', 'Chromium'] })).toBe('chrome');
    expect(browserKind({ firefox: false, brands: [] })).toBe('chrome');
    // A Firefox build is Firefox, whatever a browser claims.
    expect(browserKind({ firefox: true, brands: [] })).toBe('firefox');
    expect(browserKind({ firefox: true, brands: EDGE_BRANDS })).toBe('firefox');
  });

  it('test_browser_kind_reads_this_browser', () => {
    // jsdom has no userAgentData, like Firefox; Vitest builds for Chrome.
    expect(brandNames()).toEqual([]);
    expect(browserKind()).toBe('chrome');
    stubBrands(EDGE_BRANDS);
    expect(brandNames()).toEqual(EDGE_BRANDS);
    expect(browserKind()).toBe('edge');
    stubBrands(CHROME_BRANDS);
    expect(browserKind()).toBe('chrome');
    stubBrands(undefined);
    expect(brandNames()).toEqual([]);
    expect(browserKind()).toBe('chrome');
  });

  it('test_browser_label', () => {
    expect(browserLabel('chrome')).toBe('Chrome');
    expect(browserLabel('edge')).toBe('Edge');
    expect(browserLabel('firefox')).toBe('Firefox');
  });

  it('test_browser_version_is_name_and_major_only', () => {
    // Full Chromium versions: a reduced one (the major, then .0.0.0) reads as a public IPv4 address to pnpm scan:public.
    const cases: [string, string][] = [
      ['Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0', 'Firefox 147'],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0', 'Firefox 153'],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.55 Safari/537.36 Edg/141.0.3537.57',
        'Edge 141',
      ],
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.55 Safari/537.36',
        'Chrome 141',
      ],
      // Opera and other Chromium browsers report the Chromium version they are built on.
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.186 Safari/537.36 OPR/125.0.5729.21',
        'Chrome 140',
      ],
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
        'unknown',
      ],
      ['', 'unknown'],
    ];
    for (const [ua, expected] of cases) expect(browserVersion(ua), ua).toBe(expected);
  });
});
