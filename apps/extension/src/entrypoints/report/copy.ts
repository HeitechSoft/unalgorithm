import {
  CLOUD_ORIGIN,
  CORRECTION_ANSWER_BUSINESS_DAYS,
  MAX_CORRECTION_MESSAGE,
  REPORT_CONTACT_AFTER_HANDLED_DAYS,
  REPORT_CONTACT_KEEP_DAYS,
  REPORT_KEEP_DAYS,
  SUPPORT_EMAIL,
  WEBSITE_ORIGIN,
} from '@unalgorithm/protocol';
import type { ReportSendCode } from '../../lib/messages.ts';

/**
 * Every string the report page shows (ADR 0009 §2), in one table so tests pin them. The choice labels are core's
 * `REPORT_LINE_COPY.choices`, which the preview, the email fallback and the admin page share.
 */

/** A result the page shows after Send, and the actions it offers. */
export interface ResultCopy {
  title: string;
  body: string;
  /** Try again (the same report id), Email it instead (the person's own email program), or only Close. */
  actions: readonly ('retry' | 'email' | 'close')[];
}

const PERMISSIONS = 'menu → Add-ons and themes → unAlgorithm → Permissions';

export const REPORT_COPY = {
  pageTitle: 'Report a problem · unAlgorithm',
  title: 'Report a problem',
  lead: 'This goes to HeitechSoft, who make unAlgorithm, so we can fix it in the next update.',
  privateWindow: 'This is a private window, so the report includes nothing about the page.',
  /** Settings asks this first: a feed, or something else. */
  about: { legend: "What's it about?", linkedin: 'LinkedIn', facebook: 'Facebook', other: 'Something else' },
  /** Each kind's question. Settings' "Something else" asks the `other` kind's after its own. */
  questions: {
    detection: "What's wrong?",
    'wrong-call': "What's wrong?",
    correction: "What's wrong?",
    other: "What's it about?",
    otherAfterSettings: 'Which part of unAlgorithm?',
  },
  errors: {
    chooseMany: 'Choose at least one',
    chooseOne: 'Choose one',
    words: 'Write what went wrong in your own words.',
    email: "That doesn't look like an email address.",
  },
  words: {
    label: 'In your own words',
    hint: "Describe the claim as you understood it and why the result is wrong. Please don't paste the post or a link to it, and leave out names and any health, political or other sensitive details about you or anyone else. Email addresses, phone numbers and links are removed.",
    counter: (n: number) => `${n}/${MAX_CORRECTION_MESSAGE}`,
  },
  email: {
    label: 'Email for a reply (optional)',
    hint: `Only if you'd like a reply. We keep it until ${REPORT_CONTACT_AFTER_HANDLED_DAYS} days after we answer, and never more than ${REPORT_CONTACT_KEEP_DAYS} days.`,
    without: "Without an email we can't reply, but we review every correction and count it in our transparency report.",
    /** Firefox, while personally identifying information isn't allowed: no field, and a way to get a reply anyway. */
    noField: 'To get a reply, email us and mention your reference.',
  },
  preview: {
    heading: "What we'll send",
    exact: "Show exactly what's sent",
    exactLabel: 'The report, exactly as it is sent',
    neverSent:
      'Not sent: what posts say, names, links, pictures or your account. Nothing in the report identifies you or this browser.',
    /** A correction carries the person's own words, and their email if they give it. */
    neverSentCorrection:
      'Not sent: the post, the result or your account. Your own words are sent as shown above, and your email only if you give it.',
    destination: `Sent to unAlgorithm Cloud (${new URL(CLOUD_ORIGIN).host}), HeitechSoft's server, whatever AI you use. HeitechSoft's team reads each report to fix unAlgorithm. Kept for ${REPORT_KEEP_DAYS} days.`,
    privacy: 'Privacy policy',
    privacyHref: `${WEBSITE_ORIGIN}/privacy/`,
  },
  buttons: {
    send: 'Send report',
    sending: 'Sending…',
    cancel: 'Cancel',
    emailThis: 'Email this report',
    emailInstead: 'Email it instead',
    tryAgain: 'Try again',
    close: 'Close',
    back: (site: string) => `Back to ${site}`,
  },
  /** Firefox without technical and interaction data (ADR 0009 §5): the page never asks for it, it offers email. */
  firefoxTechnical: {
    title: 'Firefox is set not to share technical data from unAlgorithm.',
    body: `Email this report instead, or allow Technical and interaction data in Firefox: ${PERMISSIONS}.`,
  },
  /** Firefox without personal communications, for a correction's words (consent withdrawn since the result). */
  firefoxWords: {
    title: 'Firefox is set not to share what you write from unAlgorithm.',
    body: `Email this report instead, or allow Personal communications in Firefox: ${PERMISSIONS}.`,
  },
  sent: {
    title: 'Thanks, we got it.',
    body: 'We read every report. When LinkedIn or Facebook change something, the fix comes in an update, usually within a few days.',
    correctionBody: `We review every correction. If you left an email, we reply within ${CORRECTION_ANSWER_BUSINESS_DAYS} business days.`,
    reference: 'Reference',
    /** Around the support address, which links to an email with the reference as its subject. */
    more: {
      before: 'Want to tell us more, or get a reply? Email ',
      address: SUPPORT_EMAIL,
      after: ' and mention your reference.',
    },
  },
  expired: 'This report has expired. Go back to the page and choose Report a problem again.',
  loading: 'Loading the report…',
  results: {
    network: {
      title: "Couldn't send the report.",
      body: 'Check your internet connection, then try again.',
      actions: ['retry'],
    },
    'rate-limit': {
      title: "You've sent several reports in a short time.",
      body: 'Please try again in about an hour.',
      actions: ['retry'],
    },
    unavailable: {
      title: "We can't take reports right now.",
      body: 'Please try again later.',
      actions: ['retry', 'email'],
    },
    refused: {
      title: "This report couldn't be sent.",
      body: 'Update unAlgorithm and try again, or email it to us.',
      actions: ['email'],
    },
    unlisted: {
      title: "This report couldn't be sent.",
      body: 'Update unAlgorithm and try again, or email it to us.',
      actions: ['email'],
    },
    limit: {
      title: "You've sent several reports today.",
      body: 'Thank you, we have what we need.',
      actions: ['close'],
    },
    consent: {
      title: 'Firefox is set not to share technical data from unAlgorithm.',
      body: `Email this report instead, or allow Technical and interaction data in Firefox: ${PERMISSIONS}.`,
      actions: ['email'],
    },
    expired: {
      title: 'This report has expired.',
      body: 'Go back to the page and choose Report a problem again.',
      actions: ['close'],
    },
  } satisfies Record<ReportSendCode, ResultCopy>,
  /** The email fallback's subject, with the reference once there is one. */
  mailSubject: (ref?: string) => (ref ? `unAlgorithm report ${ref}` : 'unAlgorithm report'),
} as const;
