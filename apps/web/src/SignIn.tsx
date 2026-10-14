/**
 * The email-code sign-in the server's pages share: the person enters an address, the server emails a 6-digit code, and
 * the accepted code leaves Better Auth's session cookie set. The page around it decides what happens next.
 */
import { Banner, Button, ListGroup, TextField } from '@unalgorithm/ui';
import { type FormEvent, useRef, useState } from 'react';
import { ApiError, sendCode, verifyCode } from './api.ts';

const OFFLINE = "Couldn't reach the server. Try again.";
const TOO_MANY = 'Too many tries. Wait a minute and try again.';
const FAILED = 'Something went wrong. Try again.';
/** Better Auth answers 400 for a wrong or expired code and 403 once three tries have failed: either way, a new code. */
const WRONG_CODE = "That code didn't work. Check it, or send a new one.";

/** What to tell the person about a failed request; `byStatus` holds the messages one step has for its own statuses. */
export function failureMessage(err: unknown, byStatus: Partial<Record<number, string>> = {}): string {
  if (!(err instanceof ApiError)) return FAILED;
  if (err.status === 0) return OFFLINE;
  return byStatus[err.status] ?? (err.status === 429 ? TOO_MANY : FAILED);
}

export interface SignInProps {
  /** Called once the emailed code was accepted; the server has set the session cookie. */
  onSignedIn(email: string): void;
  /** Pre-fills the address (after "Use another email" on the authorize page it stays empty). */
  initialEmail?: string;
  /** A message from the page around it (the authorize page's `SIGNED_OUT`), shown until SignIn's first request starts. */
  notice?: string;
}

type Step = { name: 'email' } | { name: 'code'; email: string };

export function SignIn({ onSignedIn, initialEmail = '', notice: pageNotice }: SignInProps) {
  const [step, setStep] = useState<Step>({ name: 'email' });
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  // The page's message shows as an error would, and the first request clears it as it clears any error.
  const [error, setError] = useState<string | null>(pageNotice ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Set while a request is out, so a second submit before the busy buttons render sends nothing. */
  const inFlight = useRef(false);

  /** Runs one request with the buttons busy; a failure shows its message. Resolves to whether it succeeded. */
  async function run(action: () => Promise<void>, byStatus?: Partial<Record<number, string>>): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
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
      inFlight.current = false;
      setBusy(false);
    }
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

  async function onSignIn(event: FormEvent, address: string) {
    event.preventDefault();
    if (await run(() => verifyCode(address, code), { 400: WRONG_CODE, 403: WRONG_CODE })) onSignedIn(address);
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
            <Button type="submit" variant="primary" fullWidth loading={busy}>
              Send code
            </Button>
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
      )}
    </>
  );
}
