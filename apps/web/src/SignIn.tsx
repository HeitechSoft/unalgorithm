/**
 * The sign-in the server's pages share: the person enters an address, the server emails a 6-digit code, and the
 * accepted code leaves Better Auth's session cookie set. Below the email form, the other ways in that the discovery
 * document lists: Google leaves the page and comes back to `returnTo`, where the page finds the session as it finds any;
 * a passkey signs in on the page, as the code does. The page around it decides what happens next.
 *
 * An admin can remove a person's access (CL4-06): the admin plugin then refuses a session on every way in, answering
 * `BANNED_USER` (Google: `?error=BANNED_USER` in the address it sends the browser back to), and SignIn says so.
 */
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { EMAIL_OTP_METHOD, GOOGLE_METHOD, PASSKEY_METHOD } from '@unalgorithm/protocol';
import { Banner, Button, ListGroup, TextField } from '@unalgorithm/ui';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, getSession, googleSignInUrl, PasskeyCancelled, sendCode, signInWithPasskey, verifyCode } from './api.ts';

/** What a page says when it sends the person back to sign in because the server no longer knows the session. */
export const SIGNED_OUT = 'You were signed out. Sign in again.';

const OFFLINE = "Couldn't reach the server. Try again.";
const TOO_MANY = 'Too many tries. Wait a minute and try again.';
const FAILED = 'Something went wrong. Try again.';
/** Better Auth answers 400 for a wrong or expired code and 403 once three tries have failed: either way, a new code. */
const WRONG_CODE = "That code didn't work. Check it, or send a new one.";
const GOOGLE_FAILED = "Google sign-in didn't work. Try again, or sign in with your email.";
const PASSKEY_CANCELLED = 'Passkey sign-in was cancelled.';
/** Better Auth answers 401 for a passkey it doesn't know and 400 for one it can't verify. */
const PASSKEY_UNKNOWN =
  "That passkey isn't set up for this server. Sign in with your email, then add a passkey on your account page.";
/** The admin plugin's error code for an account whose access an admin removed. */
const BANNED_USER = 'BANNED_USER';
const REMOVED = "This account can't sign in to this server. Ask its admin.";

const EMAIL_ONLY: readonly string[] = [EMAIL_OTP_METHOD];

/** What to tell the person about a failed request; `byStatus` holds the messages one step has for its own statuses. */
export function failureMessage(err: unknown, byStatus: Partial<Record<number, string>> = {}): string {
  if (!(err instanceof ApiError)) return FAILED;
  if (err.status === 0) return OFFLINE;
  return byStatus[err.status] ?? (err.status === 429 ? TOO_MANY : FAILED);
}

/** What to tell the person about a failed passkey sign-in. */
function passkeyFailure(err: unknown): string {
  if (err instanceof PasskeyCancelled) return PASSKEY_CANCELLED;
  return failureMessage(err, { 400: PASSKEY_UNKNOWN, 401: PASSKEY_UNKNOWN });
}

/** Whether a failed Google sign-in opened this page: Better Auth sends the browser back with `?error=` in its address. */
export function googleSignInFailed(): boolean {
  return new URLSearchParams(window.location.search).has('error');
}

/** Why Google sign-in failed: the `error` value Better Auth put in this page's address, if any. */
export function googleSignInError(): string | undefined {
  return new URLSearchParams(window.location.search).get('error') ?? undefined;
}

export interface SignInProps {
  /** Called once the emailed code or a passkey was accepted; the server has set the session cookie. */
  onSignedIn(email: string): void;
  /** Pre-fills the address (after "Use another email" on the authorize page it stays empty). */
  initialEmail?: string;
  /** A message from the page around it (the authorize page's `SIGNED_OUT`), shown until SignIn's first request starts. */
  notice?: string;
  /** `info.auth.methods` from the discovery document; buttons appear only for listed methods. Default: email only. */
  methods?: readonly string[];
  /** Path and query Google sends the browser back to (this page, without `error` parameters). Default: the current path. */
  returnTo?: string;
  /** The page was opened by a failed Google sign-in (`?error=` in its address); said as `notice` is. */
  googleFailed?: boolean;
  /** That `error` value (`googleSignInError()`): `BANNED_USER` says the account was removed instead. */
  googleError?: string;
}

type Step = { name: 'email' } | { name: 'code'; email: string };
/** Which way in has a request out: its button shows the spinner, and every button waits. */
type Busy = 'email' | 'google' | 'passkey';

export function SignIn({
  onSignedIn,
  initialEmail = '',
  notice: pageNotice,
  methods = EMAIL_ONLY,
  returnTo,
  googleFailed = false,
  googleError,
}: SignInProps) {
  const [step, setStep] = useState<Step>({ name: 'email' });
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<Busy | null>(null);
  // The page's message shows as an error would, and the first request clears it as it clears any error.
  const [error, setError] = useState<string | null>(
    pageNotice ?? (googleFailed ? (googleError === BANNED_USER ? REMOVED : GOOGLE_FAILED) : null),
  );
  const [notice, setNotice] = useState<string | null>(null);
  /** Set while a request is out, so a second submit before the busy buttons render sends nothing. */
  const inFlight = useRef(false);
  /**
   * Set once the browser is on its way to Google: the page stays on screen until Google answers, so its buttons stay
   * busy until it is gone. A second try would replace the first one's state cookie and fail it on the way back.
   */
  const leaving = useRef(false);
  /** Asked once: a browser without WebAuthn gets no passkey button. */
  const [webAuthn] = useState(browserSupportsWebAuthn);
  const google = methods.includes(GOOGLE_METHOD);
  const passkey = webAuthn && methods.includes(PASSKEY_METHOD);

  /**
   * Runs one request with the buttons busy; a failure shows `describe`'s message for it. Resolves to whether it
   * succeeded.
   */
  async function run(
    action: () => Promise<void>,
    { by = 'email', describe = failureMessage }: { by?: Busy; describe?: (err: unknown) => string } = {},
  ): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(by);
    setError(null);
    setNotice(null);
    try {
      await action();
      return true;
    } catch (err) {
      // Whichever way in, the server refuses a removed account the same way.
      setError(err instanceof ApiError && err.code === BANNED_USER ? REMOVED : describe(err));
      return false;
    } finally {
      if (!leaving.current) {
        inFlight.current = false;
        setBusy(null);
      }
    }
  }

  // Back from Google out of the back-forward cache, the page is as it was left: its buttons work again.
  useEffect(() => {
    function onPageShow(event: PageTransitionEvent) {
      if (!event.persisted || !leaving.current) return;
      leaving.current = false;
      inFlight.current = false;
      setBusy(null);
    }
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

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

  async function onSignIn(event: FormEvent, address: string) {
    event.preventDefault();
    const describe = (err: unknown) => failureMessage(err, { 400: WRONG_CODE, 403: WRONG_CODE });
    if (await run(() => verifyCode(address, code), { describe })) onSignedIn(address);
  }

  /** Off to Google, busy until the page is gone; the browser comes back to `returnTo`, signed in or with `?error=`. */
  async function onGoogle() {
    const back = returnTo ?? window.location.pathname;
    await run(
      async () => {
        window.location.assign(await googleSignInUrl(back));
        leaving.current = true;
      },
      { by: 'google' },
    );
  }

  /** The browser's passkey prompt, then the address the new session belongs to. */
  async function onPasskey() {
    let address = '';
    const signedIn = await run(
      async () => {
        await signInWithPasskey();
        const session = await getSession();
        if (!session) throw new Error('The passkey was accepted, but no session followed.');
        address = session.email;
      },
      { by: 'passkey', describe: passkeyFailure },
    );
    if (signedIn) onSignedIn(address);
  }

  /** Back from the code step to fix the address; nobody is signed in yet. */
  function onEditEmail() {
    setError(null);
    setNotice(null);
    setStep({ name: 'email' });
  }

  return (
    <>
      {error ? <Banner tone="danger" title={error} /> : null}
      {notice ? <Banner tone="info" title={notice} /> : null}
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
            <Button type="submit" variant="primary" fullWidth loading={busy === 'email'} disabled={busy !== null}>
              Send code
            </Button>
            {google || passkey ? (
              <p className="web-or" aria-hidden="true">
                or
              </p>
            ) : null}
            {google ? (
              <Button fullWidth loading={busy === 'google'} disabled={busy !== null} onClick={onGoogle}>
                Continue with Google
              </Button>
            ) : null}
            {passkey ? (
              <Button fullWidth loading={busy === 'passkey'} disabled={busy !== null} onClick={onPasskey}>
                Sign in with a passkey
              </Button>
            ) : null}
          </form>
        </ListGroup>
      ) : (
        <ListGroup footer={`If ${step.email} can sign in here, a 6-digit code is on its way.`}>
          <form className="web-form ua-stack" onSubmit={(e) => onSignIn(e, step.email)}>
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
            <Button type="submit" variant="primary" fullWidth loading={busy !== null}>
              Sign in
            </Button>
            <div className="ua-hstack web-actions">
              <Button variant="plain" size="sm" disabled={busy !== null} onClick={() => onSendNewCode(step.email)}>
                Send a new code
              </Button>
              <Button variant="plain" size="sm" disabled={busy !== null} onClick={onEditEmail}>
                Use another email
              </Button>
            </div>
          </form>
        </ListGroup>
      )}
    </>
  );
}
