import { DeviceNameSchema } from '@unalgorithm/protocol';
import { browser } from 'wxt/browser';

/**
 * The short name this computer gives itself at sign-in (CL3-21), e.g. "Chrome on Windows", so people can tell their
 * devices apart in the devices list. Imports nothing of the extension's own, so `server-auth.ts` can use it.
 */

/** Not in TypeScript's DOM lib. Brand names only: no version, no user agent string. */
type UserAgentData = { brands?: readonly { brand: string }[] } | undefined;

const OS_NAMES: Record<string, string> = {
  win: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  cros: 'ChromeOS',
  android: 'Android',
};

/**
 * "Chrome on Windows", from the platform's OS and the browser's brand names; undefined when anything goes wrong, so
 * sign-in never fails over a label. No user agent string, host name or user name is read. Never throws.
 */
export async function deviceName(
  deps: { platformOs?: () => Promise<string>; brands?: () => string[] } = {},
): Promise<string | undefined> {
  try {
    const os = OS_NAMES[await (deps.platformOs ?? platformOs)()];
    const brands = (deps.brands ?? browserBrands)();
    const name = brands.includes('Microsoft Edge') ? 'Edge' : brands.includes('Opera') ? 'Opera' : 'Chrome';
    const parsed = DeviceNameSchema.safeParse(os ? `${name} on ${os}` : name);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function platformOs(): Promise<string> {
  return (await browser.runtime.getPlatformInfo()).os;
}

function browserBrands(): string[] {
  const data = (navigator as { userAgentData?: UserAgentData }).userAgentData;
  return data?.brands?.map((b) => b.brand) ?? [];
}
