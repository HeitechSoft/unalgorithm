/**
 * The admin overview every server serves at `/admin` (R38): today's figures as tiles; who uses this server, and for
 * each person the daily post cap, access and role (`AdminUsers`); the addresses invited to make an account
 * (`AdminInvites`); and the server's content-free status and its last 30 days (`AdminUsage`). Everything it shows comes
 * from the admin routes, which answer only an admin of this server (CL4-05, CL4-06): the page is the same for everyone,
 * and tells a signed-in non-admin so. It names the server only by its discovery document. The page keeps the accounts
 * list and the overview (read once) and hands its sections a way to ask for them again; a section that finds the
 * session gone sends the person back to the sign-in, saying so. The admin sidebar leads to the source control page
 * (`/admin/sources`, P3-74), the Pricing page (`/admin/prices`, PA-05) and the problem reports page
 * (`/admin/reports`, ADR 0009 §7).
 *
 * `useAdminSession` and `AdminGate` are the admin pages' shared session flow (this page's, the source control page's,
 * the Pricing page's and the problem reports page's): the discovery document, who is signed in, the page's own data
 * that only an admin gets, and every step before that data has loaded.
 */
import { ADMIN_PAGE_PATH, type ServerInfo } from '@unalgorithm/protocol';
import { Banner, Button } from '@unalgorithm/ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { AdminInvites } from './AdminInvites.tsx';
import { AdminUsage, OverviewStats, useOverview } from './AdminUsage.tsx';
import { AdminUsers } from './AdminUsers.tsx';
import { ApiError, adminUsers, getSession, serverInfo, signOut } from './api.ts';
import { type NavKey, Page, PageLoading, type TopBarAccount } from './Page.tsx';
import { failureMessage, googleSignInError, googleSignInFailed, SIGNED_OUT, SignIn } from './SignIn.tsx';
import { Card } from './ui.tsx';

const INTRO = "Who uses this server, what it costs, and how it's running.";
const SIGN_IN_INTRO = 'Sign in to manage this server.';
const NOT_ADMIN = "This account isn't an admin of this server.";
const UNREACHABLE = "Couldn't reach the server. Try again.";

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
  /** The top bar's account, once the page's data has loaded. */
  account: TopBarAccount | undefined;
}

/**
 * An admin page's session flow: the discovery document and who is signed in, then `loadData`, one of the admin routes
 * (401 without a session, 403 for a non-admin). `title` names the page in the browser's tab.
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
    step,
    load,
    reload,
    sessionEnded,
    signOut: onSignOut,
    signingOut,
    signOutError,
    googleFailed,
    googleError,
    account: step.name === 'loaded' ? { email: step.email, onSignOut: () => void onSignOut(), signingOut } : undefined,
  };
}

/**
 * An admin page before its data has loaded: loading; the server unreachable, under the page's own `intro`; the sign-in,
 * which brings the person back to `returnTo`; and a signed-in non-admin, told so, with "Sign out".
 */
export function AdminGate<T>({ session, intro, returnTo }: { session: AdminSession<T>; intro: string; returnTo: string }) {
  const { info, step } = session;
  if (step.name === 'loading') return <PageLoading />;
  if (step.name === 'signed-out' && info) {
    return (
      <Page info={info} intro={SIGN_IN_INTRO}>
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
      <Page info={info} intro={NOT_ADMIN}>
        {session.signOutError ? <Banner tone="danger" title={session.signOutError} /> : null}
        <Card className="web-not-admin">
          <p>{`Signed in as ${step.email}`}</p>
          <Button size="lg" fullWidth loading={session.signingOut} onClick={() => void session.signOut()}>
            Sign out
          </Button>
        </Card>
      </Page>
    );
  }
  return (
    <Page info={info} intro={intro}>
      <Banner tone="danger" title={UNREACHABLE} action={{ label: 'Try again', onAction: () => void session.load() }} />
    </Page>
  );
}

/** An admin page once its data has loaded: the app frame with the admin sidebar, the top bar's account and its title. */
export function AdminPage<T>({
  session,
  nav,
  title,
  intro,
  wide = true,
  actions,
  children,
}: {
  session: AdminSession<T>;
  nav: NavKey;
  title: string;
  intro: string;
  wide?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Page
      info={session.info}
      layout="app"
      title={title}
      intro={intro}
      wide={wide}
      nav={nav}
      account={session.account}
      actions={actions}
    >
      {children}
    </Page>
  );
}

export function Admin() {
  const session = useAdminSession('Admin', adminUsers);
  const { info, step, reload, sessionEnded } = session;
  const overview = useOverview(step.name === 'loaded', sessionEnded);
  if (step.name !== 'loaded' || !info) return <AdminGate session={session} intro={INTRO} returnTo={ADMIN_PAGE_PATH} />;
  return (
    <AdminPage session={session} nav="admin" title="Overview" intro={INTRO}>
      <OverviewStats overview={overview.state} users={step.data} />
      <div className="web-admin">
        <div className="web-admin-column">
          <AdminUsers data={step.data} email={step.email} reload={reload} onSignedOut={sessionEnded} />
          <AdminInvites invites={step.data.invites} reload={reload} onSignedOut={sessionEnded} />
        </div>
        <div className="web-admin-column">
          <AdminUsage overview={overview} />
        </div>
      </div>
    </AdminPage>
  );
}
