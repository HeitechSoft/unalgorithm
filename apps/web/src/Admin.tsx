/**
 * The admin page every server serves at `/admin` (R38): who uses this server, and for each person the daily post cap,
 * access and role (`AdminUsers`); the addresses invited to make an account (`AdminInvites`); and the server's usage
 * against its daily spend limit with its content-free status (`AdminUsage`). Everything it shows comes from the admin routes, which answer only an admin of this
 * server (CL4-05, CL4-06): the page is the same for everyone, and tells a signed-in non-admin so. It names the server
 * only by its discovery document. The page keeps the accounts list and hands its sections a way to ask for it again; a
 * section that finds the session gone sends the person back to the sign-in, saying so.
 */
import { ADMIN_PAGE_PATH, type AdminUsers as AdminUsersData, type ServerInfo } from '@unalgorithm/protocol';
import { Banner, Button, ListGroup, ListRow } from '@unalgorithm/ui';
import { useCallback, useEffect, useState } from 'react';
import { AdminInvites } from './AdminInvites.tsx';
import { AdminUsage } from './AdminUsage.tsx';
import { AdminUsers } from './AdminUsers.tsx';
import { ApiError, adminUsers, getSession, serverInfo, signOut } from './api.ts';
import { Page } from './Page.tsx';
import { failureMessage, googleSignInError, googleSignInFailed, SIGNED_OUT, SignIn } from './SignIn.tsx';

const INTRO = 'Who uses this server, and what each person may do.';
const SIGN_IN_INTRO = 'Sign in to manage this server.';
const NOT_ADMIN = "This account isn't an admin of this server.";
const UNREACHABLE = "Couldn't reach the server. Try again.";

type Step =
  | { name: 'loading' }
  | { name: 'unavailable' }
  | { name: 'signed-out'; notice?: string }
  | { name: 'not-admin'; email: string }
  | { name: 'loaded'; email: string; users: AdminUsersData };

export function Admin() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [step, setStep] = useState<Step>({ name: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Google sent the browser back with `?error=`: said until the person signs out, when it no longer applies. */
  const [googleFailed, setGoogleFailed] = useState(googleSignInFailed);
  const [googleError] = useState(googleSignInError);

  /** The one way to the sign-in step: after "Sign out", and (with `notice`) for any request that finds the session gone. */
  const toSignedOut = useCallback((notice?: string) => {
    setError(null);
    setGoogleFailed(false);
    setStep({ name: 'signed-out', notice });
  }, []);
  /** A request found the session gone (401): the one-day session ended, or it was signed out elsewhere. */
  const sessionEnded = useCallback(() => toSignedOut(SIGNED_OUT), [toSignedOut]);

  /** The discovery document and who is signed in, then the accounts list, which only an admin gets. */
  const load = useCallback(async () => {
    setStep({ name: 'loading' });
    setError(null);
    let email: string;
    try {
      const [found, session] = await Promise.all([serverInfo(), getSession()]);
      setInfo(found);
      document.title = `Admin · ${found.name}`;
      if (!session) {
        setStep({ name: 'signed-out' });
        return;
      }
      email = session.email;
    } catch {
      setStep({ name: 'unavailable' });
      return;
    }
    try {
      setStep({ name: 'loaded', email, users: await adminUsers() });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) sessionEnded();
      else if (err instanceof ApiError && err.status === 403) setStep({ name: 'not-admin', email });
      else setStep({ name: 'unavailable' });
    }
  }, [sessionEnded]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Asks for the accounts again and keeps the answer; rejects with the `ApiError`, for the asking section to handle. */
  const reloadUsers = useCallback(async () => {
    const users = await adminUsers();
    setStep((s) => (s.name === 'loaded' ? { ...s, users } : s));
  }, []);

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
  const heading = info ? `Admin · ${info.name}` : undefined;
  if (step.name === 'unavailable' || !info) {
    return (
      <Page info={info} heading={heading} intro={INTRO}>
        <Banner tone="danger" title={UNREACHABLE} action={{ label: 'Try again', onAction: () => void load() }} />
      </Page>
    );
  }
  if (step.name === 'signed-out') {
    return (
      <Page info={info} heading={heading} intro={SIGN_IN_INTRO}>
        <SignIn
          methods={info.auth.methods}
          returnTo={ADMIN_PAGE_PATH}
          googleFailed={googleFailed}
          googleError={googleError}
          notice={step.notice}
          onSignedIn={() => void load()}
        />
      </Page>
    );
  }
  if (step.name === 'not-admin') {
    return (
      <Page info={info} heading={heading} intro={NOT_ADMIN}>
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
      </Page>
    );
  }
  return (
    <Page info={info} heading={heading} intro={INTRO}>
      <AdminUsers data={step.users} email={step.email} reload={reloadUsers} onSignedOut={sessionEnded} />
      <AdminInvites invites={step.users.invites} reload={reloadUsers} onSignedOut={sessionEnded} />
      <AdminUsage onSignedOut={sessionEnded} />
    </Page>
  );
}
