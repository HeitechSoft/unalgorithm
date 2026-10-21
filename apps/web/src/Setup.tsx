/**
 * The page the setup link opens, `/setup#<token>` (printed by the server's setup-link command, CL4-04): the person signs
 * in with an emailed code (`SignIn`), or is already signed in here, and the page claims the link, which makes them the
 * server's first admin. The token is read from the address's fragment, which the browser never sends, and taken out of
 * the address bar and its history entry before any request: it lives only in this page's state, never in storage, a
 * cookie or a log. Without a valid token the page asks for the link and claims nothing. It names the server only by its
 * discovery document.
 *
 * Only the emailed code: Google sign-in leaves the page, and the token, kept nowhere else, would not come back with it.
 */
import { ADMIN_PAGE_PATH, SETUP_PAGE_PATH, type ServerInfo, SetupRequestSchema } from '@unalgorithm/protocol';
import { Banner, CircleCheck, LoaderCircle } from '@unalgorithm/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, claimSetup, getSession, serverInfo, signOut } from './api.ts';
import { Page, PageLoading } from './Page.tsx';
import { failureMessage, SIGNED_OUT, SignIn } from './SignIn.tsx';

const INTRO = 'Set up this server.';
const SIGN_IN_INTRO = 'Sign in with the address the setup link was made for.';
const UNREACHABLE = "Couldn't reach the server. Try again.";
const NO_LINK = 'This page needs the link from the setup-link command. Ask the person who runs this server.';
const REFUSED =
  "This setup link doesn't work. It may have expired or been used, or it was made for another address. Run setup-link again for a new one.";

type Step =
  | { name: 'loading' }
  | { name: 'unavailable' }
  | { name: 'no-link' }
  | { name: 'signed-out'; notice?: string }
  | { name: 'claiming' }
  | { name: 'done' }
  | { name: 'refused'; error?: string }
  | { name: 'failed'; message: string };

/** The token in the address's fragment; the address bar keeps only `/setup`, in the same history entry. */
function takeToken(): string {
  const token = window.location.hash.slice(1);
  window.history.replaceState(null, '', SETUP_PAGE_PATH);
  return token;
}

export function Setup() {
  // A lazy initializer, never an effect: StrictMode calls it twice in development and keeps the first result, while a
  // mount effect runs twice and its second run would find the fragment already gone.
  const [token] = useState(takeToken);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [step, setStep] = useState<Step>({ name: 'loading' });
  /**
   * Whether a load has claimed the link. StrictMode runs the mount effect, and so the load, twice, and the server takes a
   * token only once: a second claim would replace "done" with the refused message.
   */
  const loadClaimed = useRef(false);

  const claim = useCallback(async () => {
    setStep({ name: 'claiming' });
    try {
      await claimSetup(token);
      setStep({ name: 'done' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setStep({ name: 'signed-out', notice: SIGNED_OUT });
      else if (err instanceof ApiError && err.status === 403) setStep({ name: 'refused' });
      else setStep({ name: 'failed', message: failureMessage(err) });
    }
  }, [token]);

  /** Asks for the discovery document and who is signed in; with a valid link and a session, claims it once. */
  const load = useCallback(async () => {
    setStep({ name: 'loading' });
    let session: { email: string } | null;
    try {
      const [found, current] = await Promise.all([serverInfo(), getSession()]);
      setInfo(found);
      document.title = `Set up · ${found.name}`;
      session = current;
    } catch {
      setStep({ name: 'unavailable' });
      return;
    }
    if (!SetupRequestSchema.shape.token.safeParse(token).success) setStep({ name: 'no-link' });
    else if (!session) setStep({ name: 'signed-out' });
    else if (!loadClaimed.current) {
      loadClaimed.current = true;
      await claim();
    }
  }, [token, claim]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Signs out so the person can sign in with the address the link was made for; the token stays. */
  async function onSignOut() {
    try {
      await signOut();
      setStep({ name: 'signed-out' });
    } catch (err) {
      setStep({ name: 'refused', error: failureMessage(err) });
    }
  }

  if (step.name === 'loading') return <PageLoading />;
  if (step.name === 'unavailable' || !info) {
    return (
      <Page info={null} intro={INTRO}>
        <Banner tone="danger" title={UNREACHABLE} action={{ label: 'Try again', onAction: () => void load() }} />
      </Page>
    );
  }
  if (step.name === 'signed-out') {
    return (
      <Page info={info} intro={SIGN_IN_INTRO}>
        <SignIn notice={step.notice} onSignedIn={() => void claim()} />
      </Page>
    );
  }
  if (step.name === 'done') {
    return (
      <Page info={info} intro={`You're now the admin of ${info.name}.`}>
        <div className="web-card web-done">
          <CircleCheck aria-hidden="true" />
          <a className="ua-button ua-button--primary ua-button--lg ua-button--full" href={ADMIN_PAGE_PATH}>
            Open the admin page
          </a>
        </div>
      </Page>
    );
  }
  return (
    <Page info={info} intro={INTRO}>
      {step.name === 'no-link' ? <Banner tone="warning" title={NO_LINK} /> : null}
      {step.name === 'claiming' ? (
        <p className="web-status web-status--busy" role="status" aria-busy="true">
          <LoaderCircle className="ua-spin" aria-hidden="true" />
          Setting up…
        </p>
      ) : null}
      {step.name === 'refused' ? (
        <>
          {step.error ? <Banner tone="danger" title={step.error} /> : null}
          <Banner tone="danger" title={REFUSED} action={{ label: 'Sign out', onAction: () => void onSignOut() }} />
        </>
      ) : null}
      {step.name === 'failed' ? (
        <Banner tone="danger" title={step.message} action={{ label: 'Try again', onAction: () => void claim() }} />
      ) : null}
    </Page>
  );
}
