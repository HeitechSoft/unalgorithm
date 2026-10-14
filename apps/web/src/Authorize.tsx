/**
 * The page the extension opens with `launchWebAuthFlow`. It checks the link first and makes no request for a bad one.
 * Then the person signs in with an emailed code (`SignIn`), or continues as the address already signed in here, and the
 * page asks the server for a single-use code bound to the extension and sends the browser back to it. An existing
 * session never hands out a code by itself: "Continue as" needs a click.
 */
import { type AuthorizeRequest, AuthorizeRequestSchema, type ServerInfo } from '@unalgorithm/protocol';
import { Banner, Button, ListGroup } from '@unalgorithm/ui';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, authorize, getSession, serverInfo, signOut } from './api.ts';
import { Page } from './Page.tsx';
import { failureMessage, SignIn } from './SignIn.tsx';

const INTRO = 'Sign in to use AI in the UnAlgorithm Feed extension.';

const INVALID_LINK = "This sign-in link isn't valid. Start again from the UnAlgorithm extension.";
const SIGNED_OUT = 'You were signed out. Sign in again.';
const REFUSED = "This server doesn't accept sign-ins from this extension.";

type Step =
  | { name: 'loading' }
  | { name: 'unavailable' }
  | { name: 'signIn'; email?: string; notice?: string }
  | { name: 'continue'; email: string }
  | { name: 'done' };

/** The authorize request in the page's own address, or null when the link is not one the extension makes. */
function linkRequest(): AuthorizeRequest | null {
  const parsed = AuthorizeRequestSchema.safeParse(Object.fromEntries(new URLSearchParams(window.location.search)));
  return parsed.success ? parsed.data : null;
}

export function Authorize() {
  const [request] = useState(linkRequest);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [step, setStep] = useState<Step>({ name: 'loading' });
  /** Counts the returns to the sign-in step: each starts a fresh SignIn, even when no other step rendered in between. */
  const [signIns, setSignIns] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStep({ name: 'loading' });
    setError(null);
    try {
      const [found, session] = await Promise.all([serverInfo(), getSession()]);
      setInfo(found);
      document.title = `Sign in · ${found.name}`;
      setStep(session ? { name: 'continue', email: session.email } : { name: 'signIn' });
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

  /** Back to the email-code sign-in; `notice` says why, `email` pre-fills the address. */
  function toSignIn(next: { email?: string; notice?: string } = {}) {
    setSignIns((count) => count + 1);
    setStep({ name: 'signIn', ...next });
  }

  /**
   * Asks for the extension's code and sends the browser back to the extension with it. `address` is the one just
   * signed in with on this page, kept for the sign-in if the session is gone.
   */
  async function toExtension(req: AuthorizeRequest, address?: string) {
    await run(
      async () => {
        let redirect: string;
        try {
          redirect = await authorize(req);
        } catch (err) {
          // The session ended (it lasts a day, and another tab can sign out): sign in again. SignIn shows why, so the
          // message is not kept here, where it would outlast SignIn's own steps.
          if (err instanceof ApiError && err.status === 401) {
            toSignIn({ email: address, notice: SIGNED_OUT });
            return;
          }
          throw err;
        }
        setStep({ name: 'done' });
        window.location.assign(redirect);
      },
      { 403: REFUSED },
    );
  }

  async function onUseAnotherEmail() {
    if (await run(signOut)) toSignIn();
  }

  if (!request) {
    return (
      <Page info={null} intro={INTRO}>
        <Banner tone="warning" title={INVALID_LINK} />
      </Page>
    );
  }
  if (step.name === 'loading') return <div className="web-page" aria-busy="true" />;

  return (
    <Page info={info} intro={INTRO}>
      {error ? (
        <Banner
          tone="danger"
          title={error}
          action={step.name === 'unavailable' ? { label: 'Try again', onAction: () => void load() } : undefined}
        />
      ) : null}
      {step.name === 'signIn' ? (
        <SignIn
          key={signIns}
          initialEmail={step.email}
          notice={step.notice}
          onSignedIn={(address) => {
            setStep({ name: 'continue', email: address });
            void toExtension(request, address);
          }}
        />
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
