/**
 * The account page's "Your data" section (R12): download everything the server holds about the account as a JSON file,
 * and delete the account after an alert dialog that asks for the address typed again. The server deletes only for a
 * web session signed in within the last 10 minutes (CL3-15): an older one is sent back to the sign-in, saying why.
 * Deleting is immediate, with no grace period, and signs out every device; the session goes with the account. Data the
 * server does not hold stays in the extension's own "Export settings". On a server that advertises billing, each opening
 * of the dialog asks for the credit balance once and, when the account holds purchased credit, says how much and that
 * deleting gives it up (R50). The warning only informs: it never blocks the deletion.
 */
import { formatBalance } from '@unalgorithm/core';
import type { CreditAccount, ServerInfo } from '@unalgorithm/protocol';
import { Banner, Button, Dialog, Download, ListGroup, ListRow, TextField, Trash2 } from '@unalgorithm/ui';
import { useRef, useState } from 'react';
import { ApiError, creditAccount, deleteAccount, exportAccount } from './api.ts';
import { failureMessage } from './SignIn.tsx';

/** The downloaded file's name. */
export const EXPORT_FILE = 'account-export.json';
const MISMATCH = 'The address you typed does not match this account.';

export interface AccountDataProps {
  /** The signed-in address, which the person types again to delete the account. */
  email: string;
  /** The discovery document: the dialog names the server by its name. */
  info: ServerInfo;
  /** The account is deleted, and the session with it. */
  onDeleted(): void;
  /** The session is too old to delete the account (401): the page asks the person to sign in again. */
  onNeedsSignIn(): void;
  /** The server no longer knows the session (401 on the export): the page goes back to sign-in. */
  onSignedOut(): void;
}

/** The dialog's failure: a mismatched address belongs to the field, anything else to the dialog. */
type Failure = { field: boolean; message: string };
/** The credit balance the dialog checked: none asked (or still loading), the answer, or a failure. */
type CreditCheck = CreditAccount | 'failed' | null;

export function AccountData({ email, info, onDeleted, onNeedsSignIn, onSignedOut }: AccountDataProps) {
  const [error, setError] = useState<string | null>(null);
  const exporting = useRef(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [credit, setCredit] = useState<CreditCheck>(null);
  /** Counts openings, so an answer that arrives after the dialog was opened again is dropped. */
  const opening = useRef(0);
  const matches = typed.trim().toLowerCase() === email.trim().toLowerCase();

  /** The export as a download, as the extension's "Export settings" saves its file. A second click waits for the first. */
  async function onExport() {
    if (exporting.current) return;
    exporting.current = true;
    setError(null);
    try {
      const blob = await exportAccount();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = EXPORT_FILE;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setError(failureMessage(err));
    } finally {
      exporting.current = false;
    }
  }

  function onAsk() {
    setTyped('');
    setFailure(null);
    setCredit(null);
    setConfirmOpen(true);
    const current = ++opening.current;
    if (info.billing) void checkCredit(current);
  }

  /** The balance for this opening's warning; any failure (401 included) is only a footnote. */
  async function checkCredit(current: number) {
    let answer: CreditCheck;
    try {
      answer = await creditAccount();
    } catch {
      answer = 'failed';
    }
    if (current === opening.current) setCredit(answer);
  }

  async function onDelete() {
    setDeleting(true);
    setFailure(null);
    try {
      await deleteAccount(typed);
    } catch (err) {
      setDeleting(false);
      if (err instanceof ApiError && err.status === 401) {
        setConfirmOpen(false);
        onNeedsSignIn();
      } else if (err instanceof ApiError && err.status === 400) {
        setFailure({ field: true, message: MISMATCH });
      } else {
        setFailure({ field: false, message: failureMessage(err) });
      }
      return;
    }
    onDeleted();
  }

  return (
    <div className="web-section">
      {error ? <Banner tone="danger" title={error} /> : null}
      <ListGroup
        header="Your data"
        footer="A JSON file with your account, devices, sign-in methods, usage counts and synced settings."
      >
        <ListRow title="Download your data" icon={{ icon: Download, tint: 'gray' }} onSelect={() => void onExport()} />
        <ListRow title="Delete account…" tone="destructive" icon={{ icon: Trash2, tint: 'gray' }} onSelect={onAsk} />
      </ListGroup>
      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        alert
        title="Delete your account?"
        description={`This deletes your account on ${info.name}: your synced settings, devices, passkeys and usage history. Every computer signed in with this account is signed out. This can't be undone.`}
        actions={
          <>
            <Button ref={autofocus} onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive-solid" disabled={!matches} loading={deleting} onClick={() => void onDelete()}>
              Delete account
            </Button>
          </>
        }
      >
        {failure && !failure.field ? <Banner tone="danger" title={failure.message} /> : null}
        {credit === 'failed' ? (
          <p className="ua-footnote">We couldn't check your credit balance.</p>
        ) : credit && credit.balance.purchasedMicros > 0 ? (
          <Banner tone="warning" title={`You have ${formatBalance(credit.balance.purchasedMicros)} of purchased credit.`}>
            Deleting your account gives it up. To get it back, ask for a refund before you delete your account.
            {credit.refundPolicyUrl ? (
              <>
                {' '}
                <a href={credit.refundPolicyUrl} target="_blank" rel="noreferrer">
                  Refund policy
                </a>
              </>
            ) : null}
          </Banner>
        ) : null}
        <TextField
          // A fixed id rather than a generated one: the page has one such field, and its markup stays the same each time.
          id="delete-account-confirm"
          label={`Type ${email} to confirm`}
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setFailure(null);
          }}
          error={failure?.field ? failure.message : undefined}
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </Dialog>
    </div>
  );
}

/**
 * Gives "Cancel" the dialog's initial focus, ahead of the field before it. A modal dialog focuses its `[autofocus]`
 * element when it opens; React's `autoFocus` never writes that attribute (it focuses the element once, when it mounts,
 * while the dialog is still closed), so the attribute is set on the element itself.
 */
function autofocus(button: HTMLButtonElement | null) {
  button?.setAttribute('autofocus', '');
}
