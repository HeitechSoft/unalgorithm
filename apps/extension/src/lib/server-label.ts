import { canonicalText } from '@unalgorithm/core';

/**
 * How a `server` AI source is named on screen (R25, docs/brand.md). The same server code runs HeitechSoft's Cloud and
 * anyone's self-hosted copy, so "UnAlgorithm Cloud" is earned by the origin alone, never by what a server says about
 * itself. This module is the only place that knows the pinned origin.
 */
export const PINNED_CLOUD_ORIGIN = 'https://cloud.unalgorithm.app';

const CLOUD = 'UnAlgorithm Cloud';
const MAX_SERVER_NAME = 80;
const NEVER_SENT =
  "Author names, emails and phone numbers are never sent, and Facebook posts that aren't public stay on this computer.";

export interface ServerLabel {
  /** "UnAlgorithm Cloud" for the pinned origin, otherwise the server's host (port included). */
  title: string;
  /** Empty when the address can't be parsed. */
  host: string;
  isCloud: boolean;
  /** The server's own name from discovery, shown as secondary text for servers other than the Cloud. */
  serverName?: string;
}

export function serverLabel(baseUrl: string, info?: { name: string }): ServerLabel {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { title: 'Your server', host: '', isCloud: false };
  }
  const { host } = url;
  if (url.origin === PINNED_CLOUD_ORIGIN) return { title: CLOUD, host, isCloud: true };
  const name = info ? canonicalText(info.name).trim().slice(0, MAX_SERVER_NAME).trim() : '';
  const shown = name && !borrowsCloudName(name) && name.toLowerCase() !== host ? { serverName: name } : {};
  return { title: host, host, isCloud: false, ...shown };
}

/** "UnAlgorithm Cloud" however it is spaced or punctuated ("unalgorithm  cloud", "UnAlgorithm-Cloud"). */
function borrowsCloudName(name: string): boolean {
  return name
    .replace(/[^\p{L}]/gu, '')
    .toLowerCase()
    .includes('unalgorithmcloud');
}

/** Who receives post text from this server, for the flow box (`to`) and the sentence under it. */
export function recipientText(label: ServerLabel): { to: string; text: string } {
  if (label.isCloud) {
    return {
      to: CLOUD,
      text: `Post text goes from your browser to ${CLOUD}, run by HeitechSoft in Canada, which sends it to Anthropic in the United States to classify. ${CLOUD} doesn't log or keep it. ${NEVER_SENT}`,
    };
  }
  const host = label.host || 'your server';
  return {
    to: label.host || label.title,
    text: `Post text goes from your browser to ${host}. That server is run by its owner, not HeitechSoft, and its owner chooses which AI it uses. ${NEVER_SENT}`,
  };
}
