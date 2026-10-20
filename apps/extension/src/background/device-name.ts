import { DeviceNameSchema } from '@unalgorithm/protocol';
import { browser } from 'wxt/browser';
import { brandNames } from '../lib/browser-kind.ts';

/**
 * The short name this computer gives itself at sign-in (CL3-21), e.g. "Chrome on Windows" or "Firefox on Linux", so
 * people can tell their devices apart in the devices list. Imports nothing of the extension's own beyond
 * `browser-kind.ts`, which imports nothing, so `server-auth.ts` can use it.
 */

const OS_NAMES: Record<string, string> = {
  win: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  cros: 'ChromeOS',
  android: 'Android',
};

/** Chromium brand names, most specific first: every Chromium browser also lists "Chromium". */
const BRANDS: readonly [brand: string, name: string][] = [
  ['Microsoft Edge', 'Edge'],
  ['Opera', 'Opera'],
  ['Google Chrome', 'Chrome'],
  ['Chromium', 'Chromium'],
];

/**
 * "Chrome on Windows", from the platform's OS and the browser's own name: Firefox's `runtime.getBrowserInfo()`, or
 * the brand names elsewhere, and "Browser" when neither says. Undefined when anything goes wrong, so sign-in never
 * fails over a label. No user agent string, version, host name or user name is read. Never throws.
 */
export async function deviceName(
  deps: {
    platformOs?: () => Promise<string>;
    browserInfo?: () => Promise<{ name: string } | undefined>;
    brands?: () => string[];
  } = {},
): Promise<string | undefined> {
  try {
    const os = OS_NAMES[await (deps.platformOs ?? platformOs)()];
    const firefox = (await (deps.browserInfo ?? browserInfo)())?.name.trim();
    const brands = firefox ? [] : (deps.brands ?? brandNames)();
    const name = firefox || BRANDS.find(([brand]) => brands.includes(brand))?.[1] || 'Browser';
    const parsed = DeviceNameSchema.safeParse(os ? `${name} on ${os}` : name);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function platformOs(): Promise<string> {
  return (await browser.runtime.getPlatformInfo()).os;
}

/** Firefox only ("Firefox", or a Firefox-based browser's own name); Chrome and Edge have no such call. */
async function browserInfo(): Promise<{ name: string } | undefined> {
  return browser.runtime.getBrowserInfo?.();
}
