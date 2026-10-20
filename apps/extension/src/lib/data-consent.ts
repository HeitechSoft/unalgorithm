import type { AISourceConfig } from '@unalgorithm/core';
import { type Browser, browser } from 'wxt/browser';
import { browserKind } from './browser-kind.ts';

/**
 * Firefox's data-collection consent (ADR 0008, ADR 0009 §5). Its manifest declares `required: ['none']` (rules only
 * sends nothing) and, as optional, only the types its build can use: post text's two and `technicalAndInteraction` in
 * every build, and the server's in builds with the server card. `POST_DATA` and `CLOUD_DATA` are each asked for in the
 * click that first sends that kind of data to a service, together with any host permission, and checked again before
 * every send, so consent withdrawn in Firefox's add-on settings stops the sending like a removed host permission. A
 * service on this computer needs it too: a local model server or unAlgorithm server is outside the browser, and an
 * unAlgorithm server passes posts on to the AI its owner chose. `technicalAndInteraction` (`DEVICE_NAME_DATA`,
 * `REPORT_DATA`) is never asked for and only read. Chrome and Edge have no such consent: nothing here asks or refuses
 * there.
 */

export type DataCollection = Browser.permissions.DataCollection;

/**
 * Post text, or a story's search words, for an AI provider, a model server or a web search service: content of the
 * page, and other people's social media posts (Mozilla lists those under personal communications).
 */
export const POST_DATA: readonly DataCollection[] = ['websiteContent', 'personalCommunications'];
/**
 * An unAlgorithm server: post text; the people you always show or hide, by name, in synced settings; and the account the
 * sign-in registers, with this device's sign-in to it. Signing in, the server as AI source, sync, the balance and the
 * device list all need all of it; without it only signing out reaches the server.
 */
export const CLOUD_DATA: readonly DataCollection[] = [...POST_DATA, 'personallyIdentifyingInfo', 'authenticationInfo'];
/**
 * Technical and interaction data: the device name ("Firefox on Linux") a sign-in sends, and problem reports (versions,
 * the browser, counts and codes; Mozilla lists crash and error reports under it). Declared in every Firefox build.
 * Firefox offers it in its install prompt, on unless the person turns it off, and in its add-ons page; Mozilla's add-on
 * policies let nothing else depend on it. So it is never asked for (no `requestConsent` or `withConsent`), and it
 * decides two things only: whether the sign-in sends the name (`background/server-auth.ts`), and whether *Send report*
 * posts a report or hands it to the person's email program instead (`background/report.ts`, the report page). Without
 * it the device has no name, reports go by email, and everything else works the same.
 */
export const DEVICE_NAME_DATA: readonly DataCollection[] = ['technicalAndInteraction'];
/** What every problem report needs in Firefox (ADR 0009 §5): the same type as the device name, read the same way. */
export const REPORT_DATA: readonly DataCollection[] = DEVICE_NAME_DATA;

/**
 * What sending this report needs in Firefox: technical data for every report; for a correction, also the person's own
 * words (personal communications, the type post text already needed for the result being corrected) and, with a reply
 * email, personally identifying information. None of these is ever asked for by a report: without one, the report page
 * offers to email the report instead.
 */
export function reportConsent(report: { correction?: { contact?: string | undefined } | undefined }): DataCollection[] {
  return [
    ...REPORT_DATA,
    ...(report.correction ? (['personalCommunications'] as const) : []),
    ...(report.correction?.contact ? (['personallyIdentifyingInfo'] as const) : []),
  ];
}

/**
 * What a refused request to a server says while Firefox's consent to send it posts is missing. The server card's
 * Allow, in Settings → AI, asks again.
 */
export function serverConsentMessage(title: string): string {
  return `unAlgorithm needs your permission to send posts to ${title}. Open Settings → AI and allow it.`;
}

/** The consent an AI source needs: none for on-device AI, post text for any other, the whole set for a server. */
export function sourceConsent(cfg: AISourceConfig): DataCollection[] {
  switch (cfg.kind) {
    case 'on-device':
      return [];
    case 'anthropic':
    case 'openai':
    case 'openai-compatible':
      return [...POST_DATA];
    case 'server':
      return [...CLOUD_DATA];
  }
}

/**
 * A permission request from a click, with Firefox's consent for `types` added, so one prompt asks for both. Chrome and
 * Edge get `request` unchanged (they refuse a `data_collection` key). Firefox resolves true at once when it already has
 * everything asked for.
 */
export function withConsent(
  request: Browser.permissions.Permissions,
  types: readonly DataCollection[],
): Browser.permissions.Permissions {
  return browserKind() === 'firefox' && types.length ? { ...request, data_collection: [...types] } : request;
}

/**
 * Asks Firefox for its consent to send `types`, from a click: call it before anything else is awaited. Resolves true
 * when there is nothing to ask (Chrome, Edge, or no types) and false when the person declines.
 */
export function requestConsent(types: readonly DataCollection[]): Promise<boolean> {
  if (!types.length || browserKind() !== 'firefox') return Promise.resolve(true);
  return browser.permissions.request(withConsent({}, types)).catch(() => false);
}

/**
 * Whether the person agreed to send `types`. Always true in Chrome and Edge, and in a Firefox without data-collection
 * consent (its `getAll()` has no `data_collection`). False when Firefox doesn't answer, so nothing goes out on a guess.
 */
export async function hasConsent(types: readonly DataCollection[]): Promise<boolean> {
  if (!types.length || browserKind() !== 'firefox') return true;
  try {
    const granted = (await browser.permissions.getAll()).data_collection;
    return !granted || types.every((t) => granted.includes(t));
  } catch {
    return false;
  }
}
