/**
 * The admin page every server serves at `/admin` (R38): who uses this server, and for each person the daily post cap,
 * access and role (`AdminUsers`); the addresses invited to make an account (`AdminInvites`); and the server's usage
 * against its daily spend limit with its content-free status (`AdminUsage`). Everything it shows comes from the admin routes, which answer only an admin of this
 * server (CL4-05, CL4-06): the page is the same for everyone, and tells a signed-in non-admin so. It names the server
 * only by its discovery document. The page keeps the accounts list and hands its sections a way to ask for it again; a
 * section that finds the session gone sends the person back to the sign-in, saying so. Links lead to the source
 * control page (`/admin/sources`, P3-74), the Pricing page (`/admin/prices`, PA-05) and, while the server takes them,
 * the problem reports page with how many are open (`/admin/reports`, ADR 0009 §7).
 *
 * `useAdminSession` and `AdminGate` are the admin pages' shared session flow (this page's, the source control page's,
 * the Pricing page's and the problem reports page's): the discovery document, who is signed in, the page's own data
 * that only an admin gets, and every step before that data has loaded.
 */
import {
  ADMIN_PAGE_PATH,
  ADMIN_PRICES_PAGE_PATH,
  ADMIN_REPORTS_PAGE_PATH,
  ADMIN_SOURCES_PAGE_PATH,
  type AdminOverview,
  type ServerInfo,
} from '@unalgorithm/protocol';
import { Banner, Button, ListGroup, ListRow } from '@unalgorithm/ui';
import { useCallback, useEffect, useState } from 'react';
import { AdminInvites } from './AdminInvites.tsx';
import { AdminUsage } from './AdminUsage.tsx';
import { AdminUsers } from './AdminUsers.tsx';
import { ApiError, adminOverview, adminUsers, getSession, serverInfo, signOut } from './api.ts';
import { Page } from './Page.tsx';
import { failureMessage, googleSignInError, googleSignInFailed, SIGNED_OUT, SignIn } from './SignIn.tsx';

const INTRO = 'Who uses this server, and what each person may do.';
const SIGN_IN_INTRO = 'Sign in to manage this server.';
const NOT_ADMIN = "This account isn't an admin of this server.";
const UNREACHABLE = "Couldn't reach the server. Try again.";
const COUNT = new Intl.NumberFormat('en-US');

/** Where an admin page is; `data` is what the page's own admin route answered. */
export type AdminStep<T> =
  | { name: 'loading' }
  | { name: 'unavailable' }
  | { name: 'signed-out'; notice?: string }
  | { name: 'not-admin'; email: string }
  | { name: 'loaded'; email: string; data: T };

export interface AdminSession<T> {
  /** The discovery document, once it has loaded. */
  info: ServerInfo | null;
  /** "<title> · <server name>", once the discovery document has loaded. */
  heading: string | undefined;
  step: AdminStep<T>;
  /** From the start: the discovery document and the session, then the page's data. */
  load(): Promise<void>;
  /** Asks for the page's data again and keeps the answer; rejects with the `ApiError`, for the asking section. */
  reload(): Promise<void>;
  /** A request found the session gone (401): back to the sign-in, saying so. */
  sessionEnded(): void;
  /** "Sign out" on the not-admin step, its progress and its failure. */
  signOut(): Promise<void>;
  signingOut: boolean;
  signOutError: string | null;
  /** Google sent the browser back with `?error=`: said until the person signs out, when it no longer applies. */
  googleFailed: boolean;
  googleError: string | undefined;
}

/**
 * An admin page's session flow: the discovery document and who is signed in, then `loadData`, one of the admin routes
 * (401 without a session, 403 for a non-admin). `title` names the page in its heading and the browser's tab.
 * `loadData` keeps its identity (a module function), so the page loads once.
 */
export function useAdminSession<T>(title: string, loadData: () => Promise<T>): AdminSession<T> {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [step, setStep] = useState<AdminStep<T>>({ name: 'loading' });
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [googleFailed, setGoogleFailed] = useState(googleSignInFailed);
  const [googleError] = useState(googleSignInError);

  /** The one way to the sign-in step: after "Sign out", and (with `notice`) for any request that finds the session gone. */
  const toSignedOut = useCallback((notice?: string) => {
    setSignOutError(null);
    setGoogleFailed(false);
    setStep({ name: 'signed-out', notice });
  }, []);
  /** A request found the session gone (401): the one-day session ended, or it was signed out elsewhere. */
  const sessionEnded = useCallback(() => toSignedOut(SIGNED_OUT), [toSignedOut]);

  const load = useCallback(async () => {
    setStep({ name: 'loading' });
    setSignOutError(null);
    let email: string;
    try {
      const [found, session] = await Promise.all([serverInfo(), getSession()]);
      setInfo(found);
      document.title = `${title} · ${found.name}`;
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
      setStep({ name: 'loaded', email, data: await loadData() });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) sessionEnded();
      else if (err instanceof ApiError && err.status === 403) setStep({ name: 'not-admin', email });
      else setStep({ name: 'unavailable' });
    }
  }, [title, loadData, sessionEnded]);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(async () => {
    const data = await loadData();
    setStep((s) => (s.name === 'loaded' ? { ...s, data } : s));
  }, [loadData]);

  const onSignOut = useCallback(async () => {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOut();
      toSignedOut();
    } catch (err) {
      setSignOutError(failureMessage(err));
    } finally {
      setSigningOut(false);
    }
  }, [toSignedOut]);

  return {
    info,
    heading: info ? `${title} · ${info.name}` : undefined,
    step,
    load,
    reload,
    sessionEnded,
    signOut: onSignOut,
    signingOut,
    signOutError,
    googleFailed,
    googleError,
  };
}

/**
 * An admin page before its data has loaded: loading; the server unreachable, under the page's own `intro`; the sign-in,
 * which brings the person back to `returnTo`; and a signed-in non-admin, told so, with "Sign out".
 */
export function AdminGate<T>({ session, intro, returnTo }: { session: AdminSession<T>; intro: string; returnTo: string }) {
  const { info, heading, step } = session;
  if (step.name === 'loading') return <div className="web-page" aria-busy="true" />;
  if (step.name === 'signed-out' && info) {
    return (
      <Page info={info} heading={heading} intro={SIGN_IN_INTRO}>
        <SignIn
          methods={info.auth.methods}
          returnTo={returnTo}
          googleFailed={session.googleFailed}
          googleError={session.googleError}
          notice={step.notice}
          onSignedIn={() => void session.load()}
        />
      </Page>
    );
  }
  if (step.name === 'not-admin' && info) {
    return (
      <Page info={info} heading={heading} intro={NOT_ADMIN}>
        {session.signOutError ? <Banner tone="danger" title={session.signOutError} /> : null}
        <ListGroup>
          <ListRow
            title={`Signed in as ${step.email}`}
            control={
              <Button size="sm" loading={session.signingOut} onClick={() => void session.signOut()}>
                Sign out
              </Button>
            }
          />
        </ListGroup>
      </Page>
    );
  }
  return (
    <Page info={info} heading={heading} intro={intro}>
      <Banner tone="danger" title={UNREACHABLE} action={{ label: 'Try again', onAction: () => void session.load() }} />
    </Page>
  );
}

export function Admin() {
  const session = useAdminSession('Admin', adminUsers);
  const { info, heading, step, reload, sessionEnded } = session;
  if (step.name !== 'loaded' || !info) return <AdminGate session={session} intro={INTRO} returnTo={ADMIN_PAGE_PATH} />;
  return (
    <Page info={info} heading={heading} intro={INTRO} wide>
      <p className="web-status">
        <a href={ADMIN_SOURCES_PAGE_PATH}>Source list</a> · <a href={ADMIN_PRICES_PAGE_PATH}>Pricing</a>
        <ReportsLink />
      </p>
      <div className="web-admin">
        <div className="web-admin-column">
          <AdminUsers data={step.data} email={step.email} reload={reload} onSignedOut={sessionEnded} />
          <AdminInvites invites={step.data.invites} reload={reload} onSignedOut={sessionEnded} />
        </div>
        <div className="web-admin-column">
          <AdminUsage onSignedOut={sessionEnded} />
        </div>
      </div>
    </Page>
  );
}

/**
 * " · Problem reports (N open)" after the other links, once the overview says the server takes reports. It reads the
 * overview on its own: the usage section says when that fails or the session is gone, so here a failure just leaves
 * the link out. A server older than reports, or one with `REPORTS=off`, gets no link.
 */
function ReportsLink() {
  const [reports, setReports] = useState<AdminOverview['reports'] | null>(null);
  useEffect(() => {
    adminOverview().then(
      (overview) => setReports(overview.reports ?? null),
      () => setReports(null),
    );
  }, []);
  if (!reports?.enabled) return null;
  return (
    <>
      {' · '}
      <a href={ADMIN_REPORTS_PAGE_PATH}>{`Problem reports (${COUNT.format(reports.open)} open)`}</a>
    </>
  );
}
