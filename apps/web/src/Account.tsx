/**
 * The account page every server serves at `/account`, Cloud or self-hosted: who is signed in on this server, and signing
 * out, or the sign-in (`SignIn`) when nobody is, which Google comes back to. The page names the server only by its
 * discovery document. Sections go below the account row: the credits when the server advertises billing (`Credits`),
 * the devices signed in (`Devices`) and the passkeys (`Passkeys`). A section that finds the session gone sends the
 * person back to the sign-in, saying so.
 */
import { ACCOUNT_PAGE_PATH, type ServerInfo } from '@unalgorithm/protocol';
import { Banner, Button, ListGroup, ListRow } from '@unalgorithm/ui';
import { useCallback, useEffect, useState } from 'react';
import { getSession, serverInfo, signOut } from './api.ts';
import { Credits } from './Credits.tsx';
import { Devices } from './Devices.tsx';
import { Page } from './Page.tsx';
import { Passkeys } from './Passkeys.tsx';
import { failureMessage, googleSignInFailed, SIGNED_OUT, SignIn } from './SignIn.tsx';

const UNREACHABLE = "Couldn't reach the server. Try again.";

type Step =
  | { name: 'loading' }
  | { name: 'unavailable' }
  | { name: 'signed-out'; notice?: string }
  | { name: 'signed-in'; email: string };

export function Account() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [step, setStep] = useState<Step>({ name: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Google sent the browser back with `?error=`: said until the person signs out, when it no longer applies. */
  const [googleFailed, setGoogleFailed] = useState(googleSignInFailed);

  /** Asks the server for its discovery document and who is signed in, and shows the step they call for. */
  const load = useCallback(async () => {
    setStep({ name: 'loading' });
    setError(null);
    try {
      const [found, session] = await Promise.all([serverInfo(), getSession()]);
      setInfo(found);
      document.title = `Account · ${found.name}`;
      setStep(session ? { name: 'signed-in', email: session.email } : { name: 'signed-out' });
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
  /** A section's request found the session gone (401): the one-day session ended, or it was signed out elsewhere. */
  const sessionEnded = useCallback(() => toSignedOut(SIGNED_OUT), [toSignedOut]);

  async function onSignOut() {
    setBusy(true);
    setError(null);
    try {
      await signOut();
      toSignedOut();
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (step.name === 'loading') return <div className="web-page" aria-busy="true" />;
  if (step.name === 'unavailable' || !info) {
    return (
      <Page info={null} intro="Sign in to see your account.">
        <Banner tone="danger" title={UNREACHABLE} action={{ label: 'Try again', onAction: () => void load() }} />
      </Page>
    );
  }
  if (step.name === 'signed-out') {
    return (
      <Page info={info} intro="Sign in to see your account.">
        <SignIn
          methods={info.auth.methods}
          returnTo={ACCOUNT_PAGE_PATH}
          googleFailed={googleFailed}
          notice={step.notice}
          onSignedIn={() => void load()}
        />
      </Page>
    );
  }
  return (
    <Page info={info} intro="Your account on this server.">
      {error ? <Banner tone="danger" title={error} /> : null}
      <ListGroup>
        <ListRow
          title={`Signed in as ${step.email}`}
          control={
            <Button size="sm" loading={busy} onClick={onSignOut}>
              Sign out
            </Button>
          }
        />
      </ListGroup>
      {info.billing ? <Credits onSignedOut={sessionEnded} /> : null}
      <Devices onSignedOut={sessionEnded} />
      <Passkeys onSignedOut={sessionEnded} />
    </Page>
  );
}
