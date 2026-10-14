import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { type AddressInfo, createServer, type Socket } from 'node:net';
import { createTransport } from 'nodemailer';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.ts';
import { type MailMessage, memoryMailer, signInCodeEmail, smtpMailer } from '../src/mail/mailer.ts';
import { captureLog } from './support/log.ts';
import { testConfig } from './support/test-app.ts';

/** Mailpit's API (`http://127.0.0.1:8025`), or undefined. The Mailpit test skips itself when it is unset. */
const MAILPIT_URL = process.env.MAILPIT_URL?.trim().replace(/\/+$/, '') || undefined;
/** Mailpit's SMTP port, as `compose.dev.yaml` and the CI service publish it. */
const MAILPIT_SMTP_PORT = '1025';

const CODE = '482913';
const RECIPIENT = 'tom@example.com';
const MESSAGE: MailMessage = { to: RECIPIENT, ...signInCodeEmail({ code: CODE, instanceName: 'Family AI', minutes: 5 }) };

const SMTP: Config['smtp'] = {
  host: 'mail.example.org',
  port: 587,
  secure: 'starttls',
  from: 'signin@example.org',
  fromName: 'Family AI',
};

/** The limits `smtpMailer` puts on a stalled mail server, instead of nodemailer's minutes. */
const TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 };

/**
 * A `createTransport` spy: it records the options of every transport it creates and every message those transports
 * are asked to send, and each `sendMail` settles as `result` does.
 */
function fakeTransport(result: () => Promise<unknown> = async () => ({ messageId: '<1@example.org>' })) {
  const created: unknown[] = [];
  const sent: unknown[] = [];
  const create = (options: unknown) => {
    created.push(options);
    return {
      async sendMail(mail: unknown) {
        sent.push(mail);
        return result();
      },
    };
  };
  return { createTransport: create as unknown as typeof createTransport, created, sent };
}

/** Every logged line holds none of the recipient, the subject, the body or the code. */
function expectNoMessageContent(lines: string[]) {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    for (const value of [RECIPIENT, MESSAGE.subject, MESSAGE.text, CODE]) expect(line).not.toContain(value);
  }
}

describe('template and double', () => {
  it('test_memory_mailer_captures', async () => {
    const { mailer, outbox } = memoryMailer();
    await mailer.send(MESSAGE);
    const second: MailMessage = { to: 'ana@example.org', subject: 'Second', text: 'Body' };
    await mailer.send(second);
    expect(outbox).toHaveLength(2);
    expect(outbox[0]).toBe(MESSAGE);
    expect(outbox[0]).toStrictEqual({ to: RECIPIENT, subject: MESSAGE.subject, text: MESSAGE.text });
    expect(outbox[1]).toBe(second);
  });

  it('test_sign_in_code_email_text', () => {
    const email = signInCodeEmail({ code: CODE, instanceName: 'Family AI', minutes: 5 });
    expect(Object.keys(email).sort()).toEqual(['subject', 'text']);
    expect(email.subject).toBe('Your sign-in code for Family AI');
    expect(email.text).toContain(CODE);
    expect(email.text).toContain('Family AI');
    expect(email.text).toContain('5 minutes');
    // Plain text with nothing to click or load: no links, no tracking, nothing promotional.
    expect(email.text).not.toContain('http');
    expect(email.text).not.toContain('www.');
    expect(email.text).not.toContain('!');
    expect(signInCodeEmail({ code: CODE, instanceName: 'Family AI', minutes: 1 }).text).toContain('1 minute and');
  });
});

describe('smtp transport with an injected createTransport spy', () => {
  it('test_smtp_security_modes', () => {
    const { log } = captureLog();
    const modes = [
      ['tls', { secure: true }],
      ['starttls', { secure: false, requireTLS: true }],
      ['none', { secure: false, ignoreTLS: true }],
    ] as const;
    for (const [secure, options] of modes) {
      const fake = fakeTransport();
      smtpMailer({ ...SMTP, secure }, log, fake);
      // Strict: a mode adds exactly its own options, and `auth` is absent (not undefined) without a user.
      expect(fake.created).toStrictEqual([{ host: SMTP.host, port: SMTP.port, ...TIMEOUTS, ...options }]);
    }

    const fake = fakeTransport();
    smtpMailer({ ...SMTP, user: 'smtp-user', password: 'smtp-password' }, log, fake);
    expect(fake.created).toStrictEqual([
      {
        host: SMTP.host,
        port: SMTP.port,
        ...TIMEOUTS,
        secure: false,
        requireTLS: true,
        auth: { user: 'smtp-user', pass: 'smtp-password' },
      },
    ]);
  });

  it('test_smtp_send_maps_fields', async () => {
    const { log } = captureLog();
    const fake = fakeTransport();
    const mailer = smtpMailer(SMTP, log, fake);
    await mailer.send(MESSAGE);
    expect(fake.sent).toStrictEqual([
      {
        from: { name: 'Family AI', address: 'signin@example.org' },
        to: RECIPIENT,
        subject: MESSAGE.subject,
        text: MESSAGE.text,
      },
    ]);
    // One transport, made when the mailer is: sends reuse it.
    await mailer.send(MESSAGE);
    expect(fake.created).toHaveLength(1);
    expect(fake.sent).toHaveLength(2);
  });

  it('test_smtp_failure_rejects_and_logs_no_pii', async () => {
    const { log, lines, events } = captureLog();
    // SMTP servers echo the envelope in their replies, so the error's message and fields can hold the recipient.
    const failure = Object.assign(new Error(`Can't send mail - all recipients were rejected: 550 <${RECIPIENT}> ${CODE}`), {
      code: 'EENVELOPE',
      response: `550 5.1.1 <${RECIPIENT}>: Recipient address rejected`,
      rejected: [RECIPIENT],
    });
    const fake = fakeTransport(async () => {
      throw failure;
    });
    await expect(smtpMailer(SMTP, log, fake).send(MESSAGE)).rejects.toBe(failure);

    const logged = events();
    expect(logged.map((e) => e.event)).toEqual(['mail.failed']);
    expect(logged[0]).toMatchObject({ level: 'error', err_name: 'Error', err_code: 'EENVELOPE' });
    expectNoMessageContent(lines);
  });

  it('test_smtp_success_logs_no_pii', async () => {
    const { log, lines, events } = captureLog();
    await smtpMailer(SMTP, log, fakeTransport()).send(MESSAGE);

    const logged = events();
    expect(logged.map((e) => e.event)).toEqual(['mail.sent']);
    expect(Object.keys(logged[0] ?? {}).sort()).toEqual(['event', 'level', 'ms', 't']);
    expect(logged[0]).toMatchObject({ level: 'info' });
    expect(Number.isInteger(logged[0]?.ms)).toBe(true);
    expectNoMessageContent(lines);
  });
});

describe('stalled mail server', () => {
  /**
   * Real nodemailer with the one timeout `smtpMailer` sets for this stall cut to a hundredth, so the stall fails in
   * milliseconds. The others stay as set (10 s and more, past the test's 5 s), so a loaded machine that pauses this
   * process cannot end the send with another one first, such as the connection timeout before the socket connects. Had
   * `smtpMailer` left the timeout out, nodemailer's default (cut short only by the 10 s connection timeout) would run the
   * test out of time instead.
   */
  const cutTimeout = (key: keyof typeof TIMEOUTS) =>
    ((options: Record<string, unknown>) => {
      const ms = options[key];
      return createTransport(typeof ms === 'number' ? { ...options, [key]: ms / 100 } : options);
    }) as unknown as typeof createTransport;

  /**
   * A loopback SMTP server that takes the connection and then stops answering, before or after its greeting.
   * `connected` resolves once the server has the connection.
   */
  async function stallingServer(greet: boolean) {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      if (greet) socket.write('220 stall.example.org ESMTP\r\n');
    });
    const connected = once(server, 'connection');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      port: (server.address() as AddressInfo).port,
      sockets,
      connected,
      close: () =>
        new Promise((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(resolve);
        }),
    };
  }

  it('test_smtp_stalled_server_times_out', async () => {
    // No greeting at all, then a greeting and no answer to EHLO.
    for (const [greet, timeout] of [
      [false, 'greetingTimeout'],
      [true, 'socketTimeout'],
    ] as const) {
      const server = await stallingServer(greet);
      try {
        const { log, lines, events } = captureLog();
        const mailer = smtpMailer({ ...SMTP, host: '127.0.0.1', port: server.port, secure: 'none' }, log, {
          createTransport: cutTimeout(timeout),
        });
        await expect(mailer.send(MESSAGE)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
        // The server takes the connection in a callback of its own, which a loaded machine can run after the send gave
        // up: wait for it, then check it was the only one.
        await server.connected;
        expect(server.sockets.size).toBe(1);
        expect(events()).toMatchObject([{ event: 'mail.failed', level: 'error', err_code: 'ETIMEDOUT' }]);
        expectNoMessageContent(lines);
      } finally {
        await server.close();
      }
    }
  });
});

describe('development compose file', () => {
  it('test_compose_dev_publishes_only_loopback', () => {
    const compose = readFileSync(new URL('../compose.dev.yaml', import.meta.url), 'utf8');
    // Every entry of every `ports:` list, without quotes or a trailing comment.
    const ports: string[] = [];
    let inPorts = false;
    for (const line of compose.split('\n')) {
      if (/^\s+ports:\s*$/.test(line)) inPorts = true;
      else if (inPorts && /^\s+-\s/.test(line)) {
        ports.push(
          line
            .replace(/^\s+-\s+/, '')
            .replace(/\s#.*$/, '')
            .replace(/['"]/g, '')
            .trim(),
        );
      } else inPorts = false;
    }
    expect(ports).toEqual(['127.0.0.1:5432:5432', '127.0.0.1:1025:1025', '127.0.0.1:8025:8025']);
    expect(compose).not.toMatch(/network_mode:\s*host/);
  });
});

describe.skipIf(!MAILPIT_URL)('integration', () => {
  it('test_smtp_delivers_to_mailpit', { timeout: 20_000 }, async () => {
    const mailpit = MAILPIT_URL ?? '';
    const { smtp } = testConfig({
      SMTP_HOST: new URL(mailpit).hostname,
      SMTP_PORT: MAILPIT_SMTP_PORT,
      SMTP_SECURE: 'none',
    });
    // A fresh code, so an older message in the mailbox cannot pass for this one.
    const code = randomInt(100_000, 1_000_000).toString();
    const { log } = captureLog();
    await smtpMailer(smtp, log).send({
      to: 'tester@example.com',
      ...signInCodeEmail({ code, instanceName: smtp.fromName, minutes: 5 }),
    });

    // Mailpit stores a message before it answers the SMTP DATA command; the short poll only absorbs API lag.
    let text = '';
    for (let attempt = 0; attempt < 25 && !text.includes(code); attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 200));
      const res = await fetch(`${mailpit}/api/v1/message/latest`);
      if (res.ok) text = ((await res.json()) as { Text?: string }).Text ?? '';
    }
    expect(text).toContain(code);
  });
});
