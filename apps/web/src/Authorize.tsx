/**
 * The page the extension opens with `launchWebAuthFlow`. It checks the link first and makes no request for a bad one.
 * Then the person signs in with an emailed code, or continues as the address already signed in here, and the page asks
 * the server for a single-use code bound to the extension and sends the browser back to it. An existing session never
 * hands out a code by itself: "Continue as" needs a click.
 */
import { type AuthorizeRequest, AuthorizeRequestSchema, type ServerInfo } from '@unalgorithm/protocol';
import { Banner, Button, ListGroup, TextField } from '@unalgorithm/ui';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, authorize, getSession, sendCode, serverInfo, signOut, verifyCode } from './api.ts';
import { Page } from './Page.tsx';

const INTRO = 'Sign in to use AI in the UnAlgorithm Feed extension.';

const INVALID_LINK = "This sign-in link isn't valid. Start again from the UnAlgorithm extension.";
const OFFLINE = "Couldn't reach the server. Try again.";
const TOO_MANY = 'Too many tries. Wait a minute and try again.';
const FAILED = 'Something went wrong. Try again.';
/** Better Auth answers 400 for a wrong or expired code and 403 once three tries have failed: either way, a new code. */
const WRONG_CODE = "That code didn't work. Check it, or send a new one.";
const SIGNED_OUT = 'You were signed out. Sign in again.';
const REFUSED = "This server doesn't accept sign-ins from this extension.";

type Step =
  | { name: 'loading' }
  | { name: 'unavailable' }
  | { name: 'email' }
  | { name: 'code'; email: string }
  | { name: 'continue'; email: string }
  | { name: 'done' };

/** The authorize request in the page's own address, or null when the link is not one the extension makes. */
function linkRequest(): AuthorizeRequest | null {
  const parsed = AuthorizeRequestSchema.safeParse(Object.fromEntries(new URLSearchParams(window.location.search)));
  return parsed.success ? parsed.data : null;
}

/** What to tell the person about a failed request; `byStatus` holds the messages one step has for its own statuses. */
function failureMessage(err: unknown, byStatus: Partial<Record<number, string>> = {}): string {
  if (!(err instanceof ApiError)) return FAILED;
  if (err.status === 0) return OFFLINE;
  return byStatus[err.status] ?? (err.status === 429 ? TOO_MANY : FAILED);
}

export function Authorize() {
  const [request] = useState(linkRequest);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [step, setStep] = useState<Step>({ name: 'loading' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStep({ name: 'loading' });
    setError(null);
    try {
      const [found, session] = await Promise.all([serverInfo(), getSession()]);
      setInfo(found);
      document.title = `Sign in · ${found.name}`;
      setStep(session ? { name: 'continue', email: session.email } : { name: 'email' });
    } catch (err) {
      setError(failureMessage(err));
      setStep({ name: 'unavailable' });
    }
  }, []);

  useEffect(() => {
    if (request) void load();
  }, [request, load]);

  /** Runs one request with the buttons busy; a failure shows its message. Resolves to whether it succeeded. */
  async function run(action: () => Promise<void>, byStatus?: Partial<Record<number, string>>): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      return true;
    } catch (err) {
      setError(failureMessage(err, byStatus));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Asks for the extension's code and sends the browser back to the extension with it. */
  async function toExtension(req: AuthorizeRequest) {
    await run(
      async () => {
        let redirect: string;
        try {
          redirect = await authorize(req);
        } catch (err) {
          // The session ended (it lasts a day, and another tab can sign out): sign in again.
          if (err instanceof ApiError && err.status === 401) setStep({ name: 'email' });
          throw err;
        }
        setStep({ name: 'done' });
        window.location.assign(redirect);
      },
      { 401: SIGNED_OUT, 403: REFUSED },
    );
  }

  async function onSendCode(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (await run(() => sendCode(address))) {
      setCode('');
      setStep({ name: 'code', email: address });
    }
  }

  async function onSendNewCode(address: string) {
    if (await run(() => sendCode(address))) {
      setCode('');
      setNotice('New code requested.');
    }
  }

  async function onSignIn(event: FormEvent, address: string, req: AuthorizeRequest) {
    event.preventDefault();
    if (await run(() => verifyCode(address, code), { 400: WRONG_CODE, 403: WRONG_CODE })) {
      setStep({ name: 'continue', email: address });
      await toExtension(req);
    }
  }

  /** Back from the code step to fix the address; nobody is signed in yet. */
  function onEditEmail() {
    setError(null);
    setNotice(null);
    setStep({ name: 'email' });
  }

  async function onUseAnotherEmail() {
    if (await run(signOut)) setStep({ name: 'email' });
  }

  if (!request) {
    return (
      <Page info={null} intro={INTRO}>
        <Banner tone="warning" title={INVALID_LINK} />
      </Page>
    );
  }
  if (step.name === 'loading') return <div className="web-page" aria-busy="true" />;

  const banners = (
    <>
      {error ? (
        <Banner
          tone="danger"
          title={error}
          action={step.name === 'unavailable' ? { label: 'Try again', onAction: () => void load() } : undefined}
        />
      ) : null}
      {notice ? <Banner tone="info" title={notice} /> : null}
    </>
  );

  return (
    <Page info={info} intro={INTRO}>
      {banners}
      {step.name === 'email' ? (
        <ListGroup>
          <form className="web-form ua-stack" onSubmit={onSendCode}>
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button type="submit" variant="primary" fullWidth loading={busy}>
              Send code
            </Button>
          </form>
        </ListGroup>
      ) : null}
      {step.name === 'code' ? (
        <ListGroup footer={`If ${step.email} can sign in here, a 6-digit code is on its way.`}>
          <form className="web-form ua-stack" onSubmit={(e) => onSignIn(e, step.email, request)}>
            <TextField
              label="6-digit code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              autoFocus
              mono
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <Button type="submit" variant="primary" fullWidth loading={busy}>
              Sign in
            </Button>
            <div className="ua-hstack web-actions">
              <Button variant="plain" size="sm" disabled={busy} onClick={() => onSendNewCode(step.email)}>
                Send a new code
              </Button>
              <Button variant="plain" size="sm" disabled={busy} onClick={onEditEmail}>
                Use another email
              </Button>
            </div>
          </form>
        </ListGroup>
      ) : null}
      {step.name === 'continue' ? (
        <ListGroup>
          <form
            className="web-form ua-stack"
            onSubmit={(e) => {
              e.preventDefault();
              void toExtension(request);
            }}
          >
            <Button type="submit" variant="primary" fullWidth loading={busy} autoFocus>
              Continue as {step.email}
            </Button>
            <Button variant="plain" fullWidth disabled={busy} onClick={onUseAnotherEmail}>
              Use another email
            </Button>
          </form>
        </ListGroup>
      ) : null}
      {step.name === 'done' ? (
        <p className="web-status" role="status">
          Signed in. Returning to the extension.
        </p>
      ) : null}
    </Page>
  );
}
