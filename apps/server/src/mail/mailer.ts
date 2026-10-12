/**
 * Outgoing email. The server sends one kind: the sign-in code. It goes over plain SMTP to whatever provider the
 * operator configures (`SMTP_*`), so there is no provider SDK; development and CI point it at Mailpit
 * (`compose.dev.yaml`). Tests use `memoryMailer` and never open a connection.
 *
 * Logs hold timings and error codes only: never the recipient, the subject, the body or the code.
 */
import { createTransport } from 'nodemailer';
import type { Config } from '../config.ts';
import { errorFields, type Logger } from '../log.ts';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** Resolves once the mail server accepted the message; rejects when it did not. */
  send(msg: MailMessage): Promise<void>;
}

export interface SmtpMailerDeps {
  /** Default: nodemailer's. Tests pass a spy. */
  createTransport?: typeof createTransport;
}

/** Transport options for each `SMTP_SECURE` mode. `none` is refused by `loadConfig` unless the host is local. */
const SECURITY = {
  /** TLS from the first byte (port 465, usually). */
  tls: { secure: true },
  /** Plain connection upgraded with STARTTLS; a server that does not offer it fails the send. */
  starttls: { secure: false, requireTLS: true },
  /** No TLS even when offered: Mailpit and other local catchers only. */
  none: { secure: false, ignoreTLS: true },
} as const;

/** A mailer on one SMTP transport, created now; every send opens its own connection. */
export function smtpMailer(smtp: Config['smtp'], log: Logger, deps: SmtpMailerDeps = {}): Mailer {
  const transport = (deps.createTransport ?? createTransport)({
    host: smtp.host,
    port: smtp.port,
    ...SECURITY[smtp.secure],
    // `loadConfig` sets the user and the password together, or neither.
    ...(smtp.user !== undefined ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
  });
  const from = { name: smtp.fromName, address: smtp.from };

  return {
    async send({ to, subject, text }) {
      const started = performance.now();
      try {
        await transport.sendMail({ from, to, subject, text });
      } catch (err) {
        // The caller decides what the person sees. The error's message can quote the recipient, so only its fields.
        log.error('mail.failed', errorFields(err));
        throw err;
      }
      log.info('mail.sent', { ms: Math.round(performance.now() - started) });
    },
  };
}

/** A mailer that keeps every message in `outbox`, unchanged. The test double for every server test. */
export function memoryMailer(): { mailer: Mailer; outbox: MailMessage[] } {
  const outbox: MailMessage[] = [];
  return {
    mailer: {
      async send(msg) {
        outbox.push(msg);
      },
    },
    outbox,
  };
}

/**
 * The sign-in code email: plain text with no links, images or tracking, and nothing promotional, so it is a
 * transactional message (no marketing consent needed under CASL).
 */
export function signInCodeEmail(p: { code: string; instanceName: string; minutes: number }): Omit<MailMessage, 'to'> {
  const expiry = `${p.minutes} ${p.minutes === 1 ? 'minute' : 'minutes'}`;
  return {
    subject: `Your sign-in code for ${p.instanceName}`,
    text:
      `Your sign-in code is ${p.code}.\n\n` +
      `Enter it on the sign-in page to finish signing in to ${p.instanceName}. ` +
      `The code expires in ${expiry} and works once.\n\n` +
      `If you didn't ask for this code, you can ignore this email. Nobody can sign in without it.`,
  };
}
