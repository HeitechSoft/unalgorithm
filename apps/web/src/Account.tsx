/**
 * The account page every server serves at `/account`, Cloud or self-hosted: who is signed in on this server, and signing
 * out, or the sign-in (`SignIn`) when nobody is, which Google comes back to. The page names the server only by its
 * discovery document. Sections go below the account row: the credits when the server advertises billing (`Credits`),
 * the devices signed in (`Devices`), the passkeys (`Passkeys`), and the account's export and deletion (`AccountData`).
 * An admin of the server also gets the admin sidebar, which leads to the admin pages.
 * A section that finds the session gone sends the person back to the sign-in, saying so. Once the account is deleted
 * the page says so and shows nothing else: the session went with the account.
 */
import { ACCOUNT_PAGE_PATH, type ServerInfo } from '@unalgorithm/protocol';
import { Badge, Banner } from '@unalgorithm/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccountData } from './AccountData.tsx';
import { getSession, serverInfo, signOut } from './api.ts';
import { Credits } from './Credits.tsx';
import { Devices } from './Devices.tsx';
import { Page, PageLoading } from './Page.tsx';
import { Passkeys } from './Passkeys.tsx';
import { failureMessage, googleSignInError, googleSignInFailed, SIGNED_OUT, SignIn } from './SignIn.tsx';

const UNREACHABLE = "Couldn't reach the server. Try again.";
/** The server deletes an account only for a session signed in within the last 10 minutes (CL3-15). */
const SIGN_IN_TO_DELETE = 'For your safety, sign in again, then delete your account within 10 minutes.';

type Step =
  | { name: 'loading' }
  | { name: 'unavailable' }
  | { name: 'signed-out'; notice?: string }
  | { name: 'signed-in'; email: string; admin: boolean }
  | { name: 'deleted' };

export function Account() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [step, setStep] = useState<Step>({ name: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Google sent the browser back with `?error=`: said until the person signs out, when it no longer applies. */
  const [googleFailed, setGoogleFailed] = useState(googleSignInFailed);
  const [googleError] = useState(googleSignInError);

  /** Asks the server for its discovery document and who is signed in, and shows the step they call for. */
  const load = useCallback(async () => {
    setStep({ name: 'loading' });
    setError(null);
    try {
      const [found, session] = await Promise.all([serverInfo(), getSession()]);
      setInfo(found);
      document.title = `Account · ${found.name}`;
      setStep(session ? { name: 'signed-in', email: session.email, admin: session.role === 'admin' } : { name: 'signed-out' });
    } catch {
      setStep({ name: 'unavailable' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** The one way to the sign-in step: after "Sign out", and (with `notice`) for any section that finds the session gone. */
  const toSignedOut = useCallback((notice?: string) => {
    setError(null);
    setGoogleFailed(false);
    setStep({ name: 'signed-out', notice });
  }, []);
  /** Set while "Sign out" runs: a section request still in flight then answers 401, which is no surprise. */
  const signingOut = useRef(false);
  /**
   * A section's request found the session gone (401): the one-day session ended, or it was signed out elsewhere. Only
   * while signed in: a request that was in flight when the person signed out on purpose answers late, and must not show
   * "You were signed out" on the sign-in step.
   */
  const sessionEnded = useCallback(() => {
    if (signingOut.current) return;
    setError(null);
    setGoogleFailed(false);
    setStep((s) => (s.name === 'signed-in' ? { name: 'signed-out', notice: SIGNED_OUT } : s));
  }, []);

  /**
   * Deleting found the session too old: it is ended here, so signing in again starts a fresh one. A sign-out that fails
   * changes nothing that matters, as signing in replaces the session anyway.
   */
  const signInToDelete = useCallback(async () => {
    await signOut().catch(() => undefined);
    toSignedOut(SIGN_IN_TO_DELETE);
  }, [toSignedOut]);

  async function onSignOut() {
    setBusy(true);
    setError(null);
    signingOut.current = true;
    try {
      await signOut();
      toSignedOut();
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      signingOut.current = false;
      setBusy(false);
    }
  }

  if (step.name === 'loading') return <PageLoading />;
  if (step.name === 'unavailable' || !info) {
    return (
      <Page info={null} intro="Sign in to see your account.">
        <Banner tone="danger" title={UNREACHABLE} action={{ label: 'Try again', onAction: () => void load() }} />
      </Page>
    );
  }
  if (step.name === 'deleted') return <Page info={info} intro="Your account was deleted." />;
  if (step.name === 'signed-out') {
    return (
      <Page info={info} intro="Sign in to see your account.">
        <SignIn
          methods={info.auth.methods}
          returnTo={ACCOUNT_PAGE_PATH}
          googleFailed={googleFailed}
          googleError={googleError}
          notice={step.notice}
          onSignedIn={() => void load()}
        />
      </Page>
    );
  }
  return (
    <Page
      info={info}
      layout="app"
      title="Account"
      intro="Your account on this server."
      account={{ email: step.email, onSignOut: () => void onSignOut(), signingOut: busy }}
      nav={step.admin ? 'account' : undefined}
    >
      {error ? <Banner tone="danger" title={error} /> : null}
      <div className="web-card web-profile">
        <span className="web-avatar web-avatar--lg" aria-hidden="true">
          {step.email.charAt(0).toUpperCase()}
        </span>
        <div className="web-profile-text">
          <p className="web-profile-email">{`Signed in as ${step.email}`}</p>
          <p className="web-profile-server">
            {info.name}
            {step.admin ? <Badge tone="accent">Admin</Badge> : null}
          </p>
        </div>
      </div>
      {info.billing ? <Credits onSignedOut={sessionEnded} /> : null}
      <Devices onSignedOut={sessionEnded} />
      <Passkeys onSignedOut={sessionEnded} />
      <AccountData
        email={step.email}
        info={info}
        onDeleted={() => setStep({ name: 'deleted' })}
        onNeedsSignIn={() => void signInToDelete()}
        onSignedOut={sessionEnded}
      />
    </Page>
  );
}
