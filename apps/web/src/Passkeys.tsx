/**
 * The account page's Passkeys section (R9): the passkeys that sign in to this account, "Add a passkey" with the
 * browser's passkey prompt, and "Remove" after a confirm dialog. The server names a new passkey after the authenticator
 * (CL3-14), so the page asks for no name. A browser without WebAuthn can still list and remove passkeys made elsewhere.
 */
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { Banner, Button, Dialog, ListGroup, ListRow, useToast } from '@unalgorithm/ui';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, addPasskey, listPasskeys, type Passkey, PasskeyCancelled, removePasskey } from './api.ts';
import { failureMessage } from './SignIn.tsx';

const LOAD_FAILED = "Couldn't load your passkeys.";
const CANCELLED = 'Adding the passkey was cancelled.';
/** The authenticator already holds one of this account's passkeys: the options list them for it to refuse. */
const ALREADY_ADDED = 'A passkey from this device is already added.';
/** Days in the reader's time zone, written as Credits writes its days: "Oct 14, 2026". */
const DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });

type State = { name: 'loading' } | { name: 'failed' } | { name: 'loaded'; passkeys: Passkey[] };

export interface PasskeysProps {
  /** Called when the server no longer knows the session (401): the page goes back to sign-in. Keep it stable. */
  onSignedOut(): void;
}

export function Passkeys({ onSignedOut }: PasskeysProps) {
  const [state, setState] = useState<State>({ name: 'loading' });
  /** The passkey the dialog asks about. */
  const [asking, setAsking] = useState<Passkey | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** What has a request out: adding, or removing the passkey with this id. Its button shows the spinner. */
  const [busy, setBusy] = useState<{ adding: true } | { removing: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Asked once: a browser without WebAuthn gets no "Add a passkey" button. */
  const [webAuthn] = useState(browserSupportsWebAuthn);
  const toast = useToast();

  /** Lists the passkeys; `quiet` keeps the list on screen while it does (after adding one). */
  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setState({ name: 'loading' });
      setError(null);
      try {
        setState({ name: 'loaded', passkeys: await listPasskeys() });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onSignedOut();
        else setState({ name: 'failed' });
      }
    },
    [onSignedOut],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /** A failed request: back to sign-in if the session is gone, otherwise what went wrong. */
  function fail(err: unknown) {
    if (err instanceof ApiError && err.status === 401) onSignedOut();
    else if (err instanceof PasskeyCancelled) setError(CANCELLED);
    else if (err instanceof Error && err.name === 'InvalidStateError') setError(ALREADY_ADDED);
    else setError(failureMessage(err));
  }

  async function onAdd() {
    setBusy({ adding: true });
    setError(null);
    try {
      await addPasskey();
      toast({ title: 'Passkey added.' });
      await load(true);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  function onAsk(passkey: Passkey) {
    setAsking(passkey);
    setConfirmOpen(true);
  }

  async function onRemove() {
    const passkey = asking;
    setConfirmOpen(false);
    if (!passkey) return;
    setBusy({ removing: passkey.id });
    setError(null);
    try {
      await removePasskey(passkey.id);
      setState((s) => (s.name === 'loaded' ? { name: 'loaded', passkeys: s.passkeys.filter((p) => p.id !== passkey.id) } : s));
      toast({ title: 'Passkey removed.' });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="web-section" aria-busy={state.name === 'loading' || undefined}>
      {error ? <Banner tone="danger" title={error} /> : null}
      {state.name === 'failed' ? (
        <Banner tone="danger" title={LOAD_FAILED} action={{ label: 'Try again', onAction: () => void load() }} />
      ) : null}
      <ListGroup header="Passkeys" footer="Sign in with your fingerprint, face or device PIN instead of an emailed code.">
        {state.name !== 'loaded' ? null : state.passkeys.length === 0 ? (
          <ListRow title={<span className="ua-secondary">No passkeys yet.</span>} />
        ) : (
          state.passkeys.map((passkey) => (
            <ListRow
              key={passkey.id}
              title={passkey.name ?? 'Passkey'}
              subtitle={passkey.createdAt ? `Added ${DAY.format(new Date(passkey.createdAt))}` : undefined}
              control={
                <Button
                  size="sm"
                  loading={busy !== null && 'removing' in busy && busy.removing === passkey.id}
                  disabled={busy !== null}
                  onClick={() => onAsk(passkey)}
                >
                  Remove
                </Button>
              }
            />
          ))
        )}
      </ListGroup>
      <div className="web-section-actions">
        {webAuthn ? (
          <Button loading={busy !== null && 'adding' in busy} disabled={busy !== null} onClick={() => void onAdd()}>
            Add a passkey
          </Button>
        ) : (
          <p className="ua-footnote">This browser can't create passkeys.</p>
        )}
      </div>
      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        alert
        title="Remove this passkey?"
        description="You can still sign in with an emailed code."
        actions={
          <>
            {/* First, so the dialog opens with it focused: the destructive button never has the focus first. */}
            <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive-solid" onClick={() => void onRemove()}>
              Remove
            </Button>
          </>
        }
      />
    </div>
  );
}
